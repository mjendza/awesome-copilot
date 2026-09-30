import crypto from "node:crypto";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { AzureError, getSignedInContext } from "./azure.mjs";
import { discoverFrontDoors, normalizeAgentTopology } from "./frontdoor.mjs";
import { createCanvasServer } from "./server.mjs";

const instances = new Map();

function ensureInstance(instanceId) {
  let instance = instances.get(instanceId);
  if (!instance) {
    instance = {
      token: crypto.randomBytes(24).toString("hex"),
      topology: null,
      status: { phase: "idle", message: "" },
      selectedNodeId: null,
      selectedProfileId: null,
      filters: {},
      scanning: false,
    };
    instances.set(instanceId, instance);
  }
  return instance;
}

const store = {
  peek: (instanceId) => instances.get(instanceId),
  update(instanceId, mutate) {
    const instance = ensureInstance(instanceId);
    mutate(instance);
    return instance;
  },
  snapshot(instanceId) {
    const instance = ensureInstance(instanceId);
    return {
      status: instance.status,
      topology: instance.topology,
      selectedNodeId: instance.selectedNodeId,
      selectedProfileId: instance.selectedProfileId,
    };
  },
};

let session;
let canvasServer;

function setStatus(instanceId, status) {
  const instance = store.update(instanceId, (s) => {
    s.status = status;
  });
  canvasServer.broadcast(instanceId, "status", instance.status);
}

function publishTopology(instanceId, topology, status) {
  const instance = store.update(instanceId, (s) => {
    s.topology = topology;
    s.status = status;
    if (!topology.profiles.some((p) => p.id === s.selectedProfileId)) {
      s.selectedProfileId = topology.profiles[0]?.id ?? null;
    }
    if (!topology.profiles.some((p) => p.nodes.some((n) => n.id === s.selectedNodeId))) {
      s.selectedNodeId = null;
    }
  });
  canvasServer.broadcast(instanceId, "topology", { topology: instance.topology, status: instance.status });
}

/**
 * Runs a live scan for one instance. Concurrent requests are collapsed so a
 * double click on "Rescan Azure" cannot start two ARM crawls.
 */
async function runDiscovery(instanceId, filters = {}) {
  const instance = ensureInstance(instanceId);
  if (instance.scanning) return instance.topology;
  instance.scanning = true;
  instance.filters = { ...instance.filters, ...filters };

  setStatus(instanceId, { phase: "loading", message: "Connecting to Azure…" });
  try {
    const topology = await discoverFrontDoors({
      subscriptionIds: instance.filters.subscriptionIds,
      nameFilter: instance.filters.nameFilter,
      onProgress: (message) => setStatus(instanceId, { phase: "loading", message }),
    });
    publishTopology(instanceId, topology, {
      phase: topology.profiles.length ? "ready" : "empty",
      message: topology.profiles.length ? "" : topology.errors[0] || "No Front Door profiles were found.",
    });
    return topology;
  } catch (err) {
    const isAzureError = err instanceof AzureError;
    setStatus(instanceId, {
      phase: "error",
      code: isAzureError ? err.code : "unknown",
      message: err.message,
      detail: isAzureError ? err.detail : undefined,
    });
    throw err;
  } finally {
    instance.scanning = false;
  }
}

function findNode(instance, profileId, nodeId) {
  const profile = instance.topology?.profiles.find((p) => p.id === profileId) ?? instance.topology?.profiles[0];
  if (!profile) return { profile: null, node: null };
  return { profile, node: profile.nodes.find((n) => n.id === nodeId) ?? null };
}

/** Builds the upstream/downstream slice of the graph around a node. */
function describeNeighbourhood(profile, node) {
  const upstream = profile.edges.filter((e) => e.to === node.id).map((e) => profile.nodes.find((n) => n.id === e.from));
  const downstream = profile.edges.filter((e) => e.from === node.id).map((e) => profile.nodes.find((n) => n.id === e.to));
  const label = (n) => (n ? `${n.label}${n.sublabel ? ` (${n.sublabel})` : ""}` : "unknown");
  return {
    upstream: upstream.filter(Boolean).map(label),
    downstream: downstream.filter(Boolean).map(label),
  };
}

function handleAsk(instanceId, { profileId, nodeId }) {
  if (!session) return false;
  const instance = ensureInstance(instanceId);
  const { profile, node } = findNode(instance, profileId, nodeId);
  if (!profile || !node) return false;

  const { upstream, downstream } = describeNeighbourhood(profile, node);
  const details = Object.entries(node.details ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `  - ${key}: ${value}`)
    .join("\n");

  session.send({
    prompt: `The user selected a node in the Azure Front Door Topology canvas and wants it explained.

Front Door profile: ${profile.name} (${profile.kind === "classic" ? "Classic Front Door" : profile.sku})
Subscription: ${profile.subscriptionName} | Resource group: ${profile.resourceGroup}

Selected ${node.layer}: ${node.label}${node.sublabel ? ` — ${node.sublabel}` : ""}
${details ? `Configuration:\n${details}` : ""}
Upstream (traffic arrives from): ${upstream.length ? upstream.join(", ") : "nothing"}
Downstream (traffic continues to): ${downstream.length ? downstream.join(", ") : "nothing"}
${profile.warnings?.length ? `Profile findings: ${profile.warnings.slice(0, 5).join(" | ")}` : ""}

Explain what this ${node.layer} does in the request path, call out any misconfiguration or risk you can see in the configuration above (TLS, WAF coverage, caching, health probes, origin priority/weight, disabled state, unrouted resources), and give concrete next steps. Keep it short.`,
  });
  return true;
}

canvasServer = createCanvasServer({
  store,
  onRefresh: (instanceId, body) => runDiscovery(instanceId, body).catch(() => {}),
  onAsk: handleAsk,
});
const port = await canvasServer.listen();

const canvas = createCanvas({
  id: "azure-front-door-topology",
  displayName: "Azure Front Door Topology",
  description:
    "Interactive Azure Front Door map tracing the full request path from custom domains and endpoints through routes to origin groups and origins, with WAF, TLS, caching and health-probe details.",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional subscription IDs or names to scan. Defaults to every enabled subscription the signed-in account can read.",
      },
      nameFilter: { type: "string", description: "Optional case-insensitive substring filter on the Front Door profile name." },
      autoScan: { type: "boolean", description: "Scan Azure as soon as the canvas opens. Defaults to true." },
    },
    additionalProperties: false,
  },
  actions: [
    {
      name: "scan_front_doors",
      description:
        "Scan Azure for Front Door profiles (Standard/Premium and classic) and render the full topology. Returns a summary of every profile found plus any configuration findings.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionIds: { type: "array", items: { type: "string" }, description: "Subscription IDs or names to scan." },
          nameFilter: { type: "string", description: "Case-insensitive substring filter on the profile name." },
        },
        additionalProperties: false,
      },
      async handler({ instanceId, input }) {
        try {
          const topology = await runDiscovery(instanceId, input ?? {});
          return {
            generatedAt: topology.generatedAt,
            subscriptionsScanned: topology.subscriptions.length,
            profiles: topology.profiles.map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
              sku: p.sku,
              subscription: p.subscriptionName,
              resourceGroup: p.resourceGroup,
              counts: p.counts,
              warnings: p.warnings,
            })),
            errors: topology.errors,
          };
        } catch (err) {
          throw new CanvasError(err instanceof AzureError ? err.code : "scan_failed", err.message);
        }
      },
    },
    {
      name: "get_topology",
      description:
        "Return the currently rendered topology so it can be analysed: every domain, endpoint, route, origin group and origin with its configuration, plus the edges connecting them.",
      inputSchema: {
        type: "object",
        properties: {
          profileId: { type: "string", description: "Limit the result to one profile resource ID." },
          includeNodes: { type: "boolean", description: "Include full node and edge lists. Defaults to true." },
        },
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const instance = ensureInstance(instanceId);
        if (!instance.topology) {
          throw new CanvasError("no_topology", "No topology has been loaded yet. Run scan_front_doors first.");
        }
        const includeNodes = input?.includeNodes !== false;
        const profiles = instance.topology.profiles
          .filter((p) => !input?.profileId || p.id === input.profileId)
          .map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.kind,
            sku: p.sku,
            subscription: p.subscriptionName,
            resourceGroup: p.resourceGroup,
            counts: p.counts,
            warnings: p.warnings,
            ...(includeNodes ? { nodes: p.nodes, edges: p.edges } : {}),
          }));
        return {
          generatedAt: instance.topology.generatedAt,
          source: instance.topology.source,
          selectedNodeId: instance.selectedNodeId,
          profiles,
          errors: instance.topology.errors,
        };
      },
    },
    {
      name: "trace_path",
      description:
        "Trace the request path for a hostname, route, origin group or origin: returns every connected node upstream and downstream, and highlights the match in the canvas.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Hostname, route name, origin group name or origin host to trace." },
          profileId: { type: "string", description: "Optional profile resource ID to search within." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const instance = ensureInstance(instanceId);
        if (!instance.topology) {
          throw new CanvasError("no_topology", "No topology has been loaded yet. Run scan_front_doors first.");
        }
        const needle = input.query.trim().toLowerCase();
        const profiles = instance.topology.profiles.filter((p) => !input.profileId || p.id === input.profileId);

        for (const profile of profiles) {
          const match =
            profile.nodes.find((n) => n.label.toLowerCase() === needle) ??
            profile.nodes.find((n) => n.label.toLowerCase().includes(needle) || (n.sublabel ?? "").toLowerCase().includes(needle));
          if (!match) continue;

          const reachable = new Set([match.id]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const edge of profile.edges) {
              if (reachable.has(edge.from) && !reachable.has(edge.to)) {
                reachable.add(edge.to);
                grew = true;
              } else if (reachable.has(edge.to) && !reachable.has(edge.from)) {
                reachable.add(edge.from);
                grew = true;
              }
            }
          }

          store.update(instanceId, (s) => {
            s.selectedNodeId = match.id;
            s.selectedProfileId = profile.id;
          });
          canvasServer.broadcast(instanceId, "selection", { nodeId: match.id, profileId: profile.id });

          const byLayer = {};
          for (const node of profile.nodes.filter((n) => reachable.has(n.id))) {
            (byLayer[node.layer] ??= []).push({ label: node.label, sublabel: node.sublabel, state: node.state, badges: node.badges });
          }
          return { profile: profile.name, matched: { id: match.id, layer: match.layer, label: match.label }, path: byLayer };
        }

        throw new CanvasError("not_found", `Nothing in the current topology matched "${input.query}".`);
      },
    },
    {
      name: "load_topology",
      description:
        "Render a topology supplied by the agent instead of scanning Azure. Use this for planned or hypothetical Front Door designs, or when ARM access is unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          profiles: {
            type: "array",
            description: "Front Door profiles to render.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                kind: { type: "string", enum: ["afd", "classic"] },
                sku: { type: "string" },
                location: { type: "string" },
                resourceGroup: { type: "string" },
                subscriptionName: { type: "string" },
                warnings: { type: "array", items: { type: "string" } },
                nodes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      layer: { type: "string", enum: ["domain", "endpoint", "route", "originGroup", "origin"] },
                      label: { type: "string" },
                      sublabel: { type: "string" },
                      state: { type: "string", enum: ["enabled", "disabled", "warning"] },
                      badges: { type: "array", items: { type: "object", properties: { label: { type: "string" }, tone: { type: "string", enum: ["muted", "ok", "warn", "accent"] } }, required: ["label"] } },
                      details: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
                    },
                    required: ["id", "layer", "label"],
                  },
                },
                edges: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } },
                    required: ["from", "to"],
                  },
                },
              },
              required: ["name", "nodes", "edges"],
            },
          },
        },
        required: ["profiles"],
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const topology = normalizeAgentTopology(input);
        publishTopology(instanceId, topology, { phase: topology.profiles.length ? "ready" : "empty", message: "" });
        return {
          profiles: topology.profiles.map((p) => ({ id: p.id, name: p.name, counts: p.counts })),
        };
      },
    },
    {
      name: "focus_node",
      description: "Highlight one node in the canvas and dim everything not on its request path.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "Node ID from get_topology. Omit to clear the selection." },
          profileId: { type: "string" },
        },
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const instance = ensureInstance(instanceId);
        if (input?.nodeId) {
          const { profile, node } = findNode(instance, input.profileId, input.nodeId);
          if (!node) throw new CanvasError("not_found", `No node with ID "${input.nodeId}" is currently rendered.`);
          store.update(instanceId, (s) => {
            s.selectedNodeId = node.id;
            s.selectedProfileId = profile.id;
          });
          canvasServer.broadcast(instanceId, "selection", { nodeId: node.id, profileId: profile.id });
          return { focused: { id: node.id, layer: node.layer, label: node.label }, profile: profile.name };
        }
        store.update(instanceId, (s) => {
          s.selectedNodeId = null;
        });
        canvasServer.broadcast(instanceId, "selection", { nodeId: null, profileId: null });
        return { focused: null };
      },
    },
  ],
  async open({ instanceId, input }) {
    const instance = ensureInstance(instanceId);
    instance.filters = {
      subscriptionIds: input?.subscriptionIds ?? instance.filters.subscriptionIds,
      nameFilter: input?.nameFilter ?? instance.filters.nameFilter,
    };

    const shouldScan = input?.autoScan !== false && !instance.topology && !instance.scanning;
    if (shouldScan) {
      // Deliberately not awaited: the canvas renders its loading state
      // immediately and the scan streams progress over SSE.
      runDiscovery(instanceId).catch(() => {});
    }

    let subtitle = "Azure Front Door";
    try {
      const context = await getSignedInContext();
      subtitle = context.subscriptionName || subtitle;
    } catch {
      /* Signed-out state is surfaced inside the canvas, not in the title. */
    }

    const profileCount = instance.topology?.profiles.length ?? 0;
    return {
      url: `http://127.0.0.1:${port}/?instance=${encodeURIComponent(instanceId)}&token=${instance.token}`,
      title: "Front Door Topology",
      status: profileCount ? `${profileCount} profile${profileCount === 1 ? "" : "s"} · ${subtitle}` : subtitle,
    };
  },
  onClose({ instanceId }) {
    canvasServer.closeInstance(instanceId);
    instances.delete(instanceId);
  },
});

session = await joinSession({ canvases: [canvas] });
