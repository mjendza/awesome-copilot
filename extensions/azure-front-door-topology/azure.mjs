import { execFile } from "node:child_process";

const ARM_RESOURCE = "https://management.azure.com";
const AZ_TIMEOUT_MS = 60_000;
const AZ_MAX_BUFFER = 8 * 1024 * 1024;
const TOKEN_SKEW_MS = 120_000;

export class AzureError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "AzureError";
    this.code = code;
    this.detail = detail;
  }
}

// `az` is a .cmd shim on Windows, and Node refuses to spawn .cmd without a
// shell. Routing through `cmd.exe /d /s /c "<line>"` keeps the arguments
// verbatim: /s strips only the outermost quote pair, so every inner quoted
// token reaches the CLI with shell metacharacters inert. The program name is
// deliberately left unquoted — quoting it defeats PATHEXT resolution of the
// shim and the CLI then fails with "Failed to load python executable".
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildInvocation(args) {
  if (process.platform !== "win32") {
    return { command: "az", args, options: {} };
  }
  const line = ["az", ...args.map(quoteForCmd)].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function runAz(args) {
  const { command, args: spawnArgs, options } = buildInvocation(args);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      spawnArgs,
      { ...options, timeout: AZ_TIMEOUT_MS, maxBuffer: AZ_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const text = `${stderr || ""}${error.message || ""}`;
        if (error.code === "ENOENT" || /not recognized|command not found/i.test(text)) {
          reject(
            new AzureError(
              "az_not_installed",
              "The Azure CLI (az) was not found on PATH. Install it from https://aka.ms/azure-cli, then reload the canvas.",
            ),
          );
          return;
        }
        if (/az login|Please run ['"]?az login|no subscription found|AADSTS/i.test(text)) {
          reject(new AzureError("az_not_logged_in", "Not signed in to Azure. Run `az login`, then reload the canvas."));
          return;
        }
        reject(new AzureError("az_failed", `Azure CLI call failed: ${(stderr || error.message || "").trim()}`));
      },
    );
  });
}

let cachedToken = null;
let cachedContext = null;

async function getAccessToken(force = false) {
  if (!force && cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return cachedToken;
  }
  const stdout = await runAz(["account", "get-access-token", "--resource", ARM_RESOURCE, "--output", "json"]);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AzureError("az_failed", "Could not parse the access token returned by the Azure CLI.");
  }
  if (!parsed?.accessToken) {
    throw new AzureError("az_not_logged_in", "Not signed in to Azure. Run `az login`, then reload the canvas.");
  }
  // `expires_on` is epoch seconds; `expiresOn` is a local-time string whose
  // timezone is ambiguous, so it is only a fallback.
  const expiresAt = parsed.expires_on
    ? Number(parsed.expires_on) * 1000
    : Date.parse(parsed.expiresOn) || Date.now() + 5 * 60_000;
  cachedToken = { token: parsed.accessToken, expiresAt, tenantId: parsed.tenant, subscriptionId: parsed.subscription };
  return cachedToken;
}

export async function getSignedInContext() {
  // Cached because `open` runs on every panel open and rehydrate, and spawning
  // the CLI there would add a second of latency before the iframe appears.
  if (cachedContext) return cachedContext;
  const stdout = await runAz(["account", "show", "--output", "json"]);
  try {
    const account = JSON.parse(stdout);
    cachedContext = {
      subscriptionId: account.id,
      subscriptionName: account.name,
      tenantId: account.tenantId,
      user: account.user?.name,
    };
    return cachedContext;
  } catch {
    throw new AzureError("az_failed", "Could not parse `az account show` output.");
  }
}

async function armFetch(url, { method = "GET", body, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { token } = await getAccessToken(attempt > 0 && lastError?.status === 401);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(AZ_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = new AzureError("arm_unreachable", `Could not reach Azure Resource Manager: ${err.message}`);
      if (attempt === retries) throw lastError;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }

    const detail = await response.text().catch(() => "");
    lastError = new AzureError(
      response.status === 403 ? "arm_forbidden" : "arm_error",
      `Azure Resource Manager returned ${response.status} for ${new URL(url).pathname}`,
      detail.slice(0, 600),
    );
    lastError.status = response.status;

    const retryable = response.status === 429 || response.status >= 500 || response.status === 401;
    if (!retryable || attempt === retries) throw lastError;
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt));
  }
  throw lastError;
}

export async function armGet(resourcePath, apiVersion) {
  const url = new URL(`${ARM_RESOURCE}${resourcePath}`);
  url.searchParams.set("api-version", apiVersion);
  return armFetch(url.toString());
}

/** Follows `nextLink` paging and returns the concatenated `value` arrays. */
export async function armList(resourcePath, apiVersion) {
  let url = new URL(`${ARM_RESOURCE}${resourcePath}`);
  url.searchParams.set("api-version", apiVersion);
  const items = [];
  let guard = 0;
  let next = url.toString();
  while (next && guard < 50) {
    const page = await armFetch(next);
    if (Array.isArray(page.value)) items.push(...page.value);
    next = page.nextLink || null;
    guard += 1;
  }
  return items;
}

/**
 * Runs an Azure Resource Graph (KQL) query across the supplied subscriptions,
 * following `$skipToken` paging. Resource Graph is a core ARM provider, so it
 * needs no `az` extension.
 */
export async function resourceGraphQuery(query, { subscriptions, pageSize = 1000, maxPages = 40 } = {}) {
  const url = `${ARM_RESOURCE}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`;
  const rows = [];
  let skipToken;
  for (let page = 0; page < maxPages; page += 1) {
    const body = {
      query,
      options: { resultFormat: "objectArray", $top: pageSize, ...(skipToken ? { $skipToken: skipToken } : {}) },
    };
    if (subscriptions?.length) body.subscriptions = subscriptions;
    const result = await armFetch(url, { method: "POST", body });
    if (Array.isArray(result.data)) rows.push(...result.data);
    skipToken = result.$skipToken;
    if (!skipToken) break;
  }
  return rows;
}

export async function listSubscriptions() {
  const subs = await armList("/subscriptions", "2022-12-01");
  return subs
    .filter((s) => s.state === "Enabled")
    .map((s) => ({ id: s.subscriptionId, name: s.displayName, tenantId: s.tenantId }));
}

export function shortId(resourceId) {
  return String(resourceId || "").split("/").pop() || "";
}

export function parseResourceId(resourceId) {
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\//i.exec(String(resourceId || ""));
  return { subscriptionId: match?.[1] ?? null, resourceGroup: match?.[2] ?? null };
}
