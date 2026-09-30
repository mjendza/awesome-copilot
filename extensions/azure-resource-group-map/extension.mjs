import crypto from "node:crypto";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { AzureError, getSignedInContext } from "./azure.mjs";
import { CATEGORIES, discoverResourceMap, normalizeAgentMap } from "./resources.mjs";
import { createCanvasServer } from "./server.mjs";

const instances = new Map();
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

function ensureInstance(instanceId) {
  let instance = instances.get(instanceId);
  if (!instance) {
    instance = {
      token: crypto.randomBytes(24).toString("hex"),
      map: null,
      status: { phase: "idle", message: "" },
      selection: null,
      // Agent-applied view, kept in the store so it survives an iframe reload,
      // a provider reconnect, or a re-open of the same instance.
      view: null,
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
    return { status: instance.status, map: instance.map, selection: instance.selection, view: instance.view };
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

function publishMap(instanceId, map, status) {
  const instance = store.update(instanceId, (s) => {
    s.map = map;
    s.status = status;
    s.selection = null;
  });
  canvasServer.broadcast(instanceId, "map", { map: instance.map, status: instance.status });
}

/** Runs a live scan for one instance, collapsing concurrent requests. */
async function runDiscovery(instanceId, filters = {}) {
  const instance = ensureInstance(instanceId);
  if (instance.scanning) return instance.map;
  instance.scanning = true;
  instance.filters = { ...instance.filters, ...filters };

  setStatus(instanceId, { phase: "loading", message: "Connecting to Azure…" });
  try {
    const map = await discoverResourceMap({
      subscriptionIds: instance.filters.subscriptionIds,
      groupFilter: instance.filters.groupFilter,
      onProgress: (message) => setStatus(instanceId, { phase: "loading", message }),
    });
    publishMap(instanceId, map, {
      phase: map.groups.length ? "ready" : "empty",
      message: map.groups.length ? "" : map.errors[0] || "No resource groups were found.",
    });
    return map;
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

function requireMap(instanceId) {
  const instance = ensureInstance(instanceId);
  if (!instance.map) {
    throw new CanvasError("no_map", "No resource map has been loaded yet. Run scan_resource_groups first.");
  }
  return instance;
}

function findGroup(instance, idOrName) {
  const needle = String(idOrName).toLowerCase();
  return (
    instance.map.groups.find((g) => g.id.toLowerCase() === needle) ??
    instance.map.groups.find((g) => g.name.toLowerCase() === needle) ??
    instance.map.groups.find((g) => g.name.toLowerCase().includes(needle)) ??
    null
  );
}

function handleAsk(instanceId, body) {
  if (!session) return false;
  const instance = ensureInstance(instanceId);
  if (!instance.map) return false;

  if (body.kind === "resource") {
    const group = instance.map.groups.find((g) => g.resources.some((r) => r.id === body.id));
    const resource = group?.resources.find((r) => r.id === body.id);
    if (!resource) return false;
    const siblings = group.types
      .slice(0, 8)
      .map((t) => `${t.type} x${t.count}`)
      .join(", ");
    session.send({
      prompt: `The user selected a resource in the Azure Resource Group Map canvas and wants it explained.

Resource: ${resource.name}
Type: ${resource.type}${resource.kind ? ` (kind: ${resource.kind})` : ""}
Region: ${resource.location}${resource.sku ? ` | SKU: ${resource.sku}` : ""}
Resource group: ${group.name} (${group.resourceCount} resources) in subscription ${group.subscriptionName}
Tags: ${Object.keys(resource.tags ?? {}).length ? Object.entries(resource.tags).map(([k, v]) => `${k}=${v}`).join(", ") : "none"}
${resource.managedBy ? `Managed by: ${resource.managedBy}` : ""}
Neighbouring resource types in the same group: ${siblings}

Explain what this resource does in the context of its resource group, how it most likely relates to the neighbouring resources, and flag anything worth acting on (missing tags, region mismatch, SKU concerns, orphaned resource). Keep it short.`,
    });
    return true;
  }

  const group = body.groupBy === "resourceGroup" ? findGroup(instance, body.id) : null;
  if (group) {
    session.send({
      prompt: `The user selected a resource group in the Azure Resource Group Map canvas and wants it explained.

Resource group: ${group.name}
Subscription: ${group.subscriptionName} | Region: ${group.location}
Resources: ${group.resourceCount} (${group.untaggedCount} untagged, ${group.managedCount} managed by another resource)
Families: ${group.categories.map((c) => `${c.id} x${c.count}`).join(", ") || "none"}
Types: ${group.types.slice(0, 15).map((t) => `${t.type} x${t.count}`).join(", ") || "none"}
Regions: ${group.locations.map((l) => `${l.location} x${l.count}`).join(", ")}
Resource group tags: ${Object.keys(group.tags ?? {}).length ? Object.entries(group.tags).map(([k, v]) => `${k}=${v}`).join(", ") : "none"}
${group.warnings.length ? `Findings: ${group.warnings.join(" | ")}` : ""}

Infer what workload this resource group hosts from its composition, describe how the pieces most likely fit together, and call out governance or architecture issues worth acting on. Keep it short.`,
    });
    return true;
  }

  const visible = instance.map.groups.flatMap((g) => g.resources);
  session.send({
    prompt: `The user selected the "${body.cardTitle}" bucket in the Azure Resource Group Map canvas (grouped by ${body.groupBy}).

Across the scanned subscriptions there are ${instance.map.stats.totalResources} resources in ${instance.map.stats.totalGroups} resource groups.
Families: ${instance.map.stats.byCategory.map((c) => `${c.id} x${c.count}`).join(", ")}
Regions: ${instance.map.stats.byLocation.map((l) => `${l.location} x${l.count}`).join(", ")}
Top types: ${instance.map.stats.byType.slice(0, 12).map((t) => `${t.type} x${t.count}`).join(", ")}
Untagged resources: ${instance.map.stats.untaggedResources} of ${visible.length}

Explain what this grouping tells the user about their estate and what they should look at next. Keep it short.`,
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
  id: "azure-resource-group-map",
  displayName: "Azure Resource Group Map",
  description:
    "Visual map of Azure resources grouped per resource group, colour coded by resource family, with region, SKU, tag-coverage and governance findings across every subscription the signed-in account can read.",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional subscription IDs or names to scan. Defaults to every enabled subscription the signed-in account can read.",
      },
      groupFilter: { type: "string", description: "Optional case-insensitive substring filter on the resource group name." },
      autoScan: { type: "boolean", description: "Scan Azure as soon as the canvas opens. Defaults to true." },
    },
    additionalProperties: false,
  },
  actions: [
    {
      name: "scan_resource_groups",
      description:
        "Scan Azure with Resource Graph and render a map of every resource group and the resources inside it. Returns per-group counts, family and region breakdowns, and governance findings.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionIds: { type: "array", items: { type: "string" }, description: "Subscription IDs or names to scan." },
          groupFilter: { type: "string", description: "Case-insensitive substring filter on the resource group name." },
        },
        additionalProperties: false,
      },
      async handler({ instanceId, input }) {
        try {
          const map = await runDiscovery(instanceId, input ?? {});
          return {
            generatedAt: map.generatedAt,
            subscriptionsScanned: map.subscriptions.length,
            stats: map.stats,
            groups: map.groups.map((g) => ({
              name: g.name,
              subscription: g.subscriptionName,
              location: g.location,
              resourceCount: g.resourceCount,
              untaggedCount: g.untaggedCount,
              categories: g.categories,
              warnings: g.warnings,
            })),
            errors: map.errors,
          };
        } catch (err) {
          throw new CanvasError(err instanceof AzureError ? err.code : "scan_failed", err.message);
        }
      },
    },
    {
      name: "get_resource_map",
      description:
        "Return the rendered map for analysis: resource groups with their resources, types, regions, SKUs and tags, plus estate-wide statistics.",
      inputSchema: {
        type: "object",
        properties: {
          resourceGroup: { type: "string", description: "Limit the result to one resource group name or resource ID." },
          includeResources: { type: "boolean", description: "Include the full resource list per group. Defaults to true." },
          maxGroups: { type: "number", description: "Cap the number of groups returned, largest first." },
        },
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const instance = requireMap(instanceId);
        const includeResources = input?.includeResources !== false;
        let groups = instance.map.groups;
        if (input?.resourceGroup) {
          const group = findGroup(instance, input.resourceGroup);
          if (!group) throw new CanvasError("not_found", `No resource group matched "${input.resourceGroup}".`);
          groups = [group];
        }
        if (input?.maxGroups) groups = groups.slice(0, input.maxGroups);

        return {
          generatedAt: instance.map.generatedAt,
          source: instance.map.source,
          stats: instance.map.stats,
          subscriptions: instance.map.subscriptions,
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            subscription: g.subscriptionName,
            location: g.location,
            tags: g.tags,
            resourceCount: g.resourceCount,
            untaggedCount: g.untaggedCount,
            categories: g.categories,
            types: g.types,
            locations: g.locations,
            warnings: g.warnings,
            ...(includeResources ? { resources: g.resources } : {}),
          })),
          errors: instance.map.errors,
        };
      },
    },
    {
      name: "find_resources",
      description:
        "Search the rendered map for resources by name, type, region or tag and return the matches grouped by resource group. Use this to answer questions like 'where are my key vaults' or 'which resources are untagged'.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring matched against name, type, region, kind, SKU and tags." },
          category: { type: "string", enum: CATEGORY_IDS, description: "Limit the search to one resource family." },
          untaggedOnly: { type: "boolean", description: "Only return resources that carry no tags." },
          limit: { type: "number", description: "Maximum number of matches to return. Defaults to 100." },
        },
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const instance = requireMap(instanceId);
        const needle = input?.query?.trim().toLowerCase() ?? "";
        const limit = input?.limit ?? 100;
        const matches = [];

        for (const group of instance.map.groups) {
          for (const resource of group.resources) {
            if (input?.category && resource.category !== input.category) continue;
            if (input?.untaggedOnly && Object.keys(resource.tags ?? {}).length > 0) continue;
            if (needle) {
              const haystack = [resource.name, resource.type, resource.location, resource.kind, resource.sku, ...Object.entries(resource.tags ?? {}).flat()]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              if (!haystack.includes(needle)) continue;
            }
            matches.push({
              name: resource.name,
              type: resource.type,
              category: resource.category,
              location: resource.location,
              sku: resource.sku,
              tags: resource.tags,
              resourceGroup: group.name,
              subscription: group.subscriptionName,
              id: resource.id,
            });
          }
        }

        return {
          totalMatches: matches.length,
          truncated: matches.length > limit,
          matches: matches.slice(0, limit),
        };
      },
    },
    {
      name: "set_view",
      description: "Change how the map is grouped and filtered in the canvas: by resource group, resource family, region or resource type.",
      inputSchema: {
        type: "object",
        properties: {
          groupBy: { type: "string", enum: ["resourceGroup", "category", "location", "type"], description: "How to bucket the cards." },
          search: { type: "string", description: "Text filter applied to every resource. Pass an empty string to clear it." },
          categories: {
            type: "array",
            items: { type: "string", enum: CATEGORY_IDS },
            description: "Resource families to keep visible. Omit to show every family.",
          },
        },
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        requireMap(instanceId);
        const instance = ensureInstance(instanceId);
        const view = {
          groupBy: input?.groupBy ?? instance.view?.groupBy,
          search: input?.search ?? instance.view?.search,
          categories: input?.categories ?? CATEGORY_IDS,
        };
        store.update(instanceId, (s) => {
          s.view = view;
        });
        canvasServer.broadcast(instanceId, "filters", view);
        return { applied: view };
      },
    },
    {
      name: "load_resource_map",
      description:
        "Render a resource map supplied by the agent instead of scanning Azure. Use this for planned or hypothetical estates, or when ARM access is unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            description: "Resource groups to render.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                location: { type: "string" },
                subscriptionName: { type: "string" },
                tags: { type: "object", additionalProperties: { type: "string" } },
                warnings: { type: "array", items: { type: "string" } },
                resources: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      type: { type: "string", description: "Full ARM type, e.g. Microsoft.Web/sites." },
                      kind: { type: "string" },
                      sku: { type: "string" },
                      location: { type: "string" },
                      category: { type: "string", enum: CATEGORY_IDS, description: "Override the family inferred from the type." },
                      tags: { type: "object", additionalProperties: { type: "string" } },
                    },
                    required: ["name", "type"],
                  },
                },
              },
              required: ["name", "resources"],
            },
          },
        },
        required: ["groups"],
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const map = normalizeAgentMap(input);
        publishMap(instanceId, map, { phase: map.groups.length ? "ready" : "empty", message: "" });
        return { stats: map.stats, groups: map.groups.map((g) => ({ name: g.name, resourceCount: g.resourceCount })) };
      },
    },
    {
      name: "focus_group",
      description: "Select a resource group in the canvas so its composition is shown in the detail panel.",
      inputSchema: {
        type: "object",
        properties: { resourceGroup: { type: "string", description: "Resource group name or ID. Omit to clear the selection." } },
        additionalProperties: false,
      },
      handler({ instanceId, input }) {
        const instance = requireMap(instanceId);
        if (!input?.resourceGroup) {
          store.update(instanceId, (s) => {
            s.selection = null;
          });
          canvasServer.broadcast(instanceId, "selection", { selection: null });
          return { focused: null };
        }
        const group = findGroup(instance, input.resourceGroup);
        if (!group) throw new CanvasError("not_found", `No resource group matched "${input.resourceGroup}".`);
        const selection = { kind: "group", id: group.id };
        store.update(instanceId, (s) => {
          s.selection = selection;
          s.view = { ...(s.view ?? {}), groupBy: "resourceGroup" };
        });
        canvasServer.broadcast(instanceId, "filters", { groupBy: "resourceGroup" });
        canvasServer.broadcast(instanceId, "selection", { selection });
        return {
          focused: group.name,
          resourceCount: group.resourceCount,
          categories: group.categories,
          types: group.types.slice(0, 15),
        };
      },
    },
  ],
  async open({ instanceId, input }) {
    const instance = ensureInstance(instanceId);
    instance.filters = {
      subscriptionIds: input?.subscriptionIds ?? instance.filters.subscriptionIds,
      groupFilter: input?.groupFilter ?? instance.filters.groupFilter,
    };

    if (input?.autoScan !== false && !instance.map && !instance.scanning) {
      // Deliberately not awaited: the canvas renders its loading state
      // immediately and the scan streams progress over SSE.
      runDiscovery(instanceId).catch(() => {});
    }

    let subtitle = "Azure";
    try {
      const context = await getSignedInContext();
      subtitle = context.subscriptionName || subtitle;
    } catch {
      /* Signed-out state is surfaced inside the canvas, not in the title. */
    }

    const stats = instance.map?.stats;
    return {
      url: `http://127.0.0.1:${port}/?instance=${encodeURIComponent(instanceId)}&token=${instance.token}`,
      title: "Resource Group Map",
      status: stats ? `${stats.totalGroups} groups · ${stats.totalResources} resources` : subtitle,
    };
  },
  onClose({ instanceId }) {
    canvasServer.closeInstance(instanceId);
    instances.delete(instanceId);
  },
});

session = await joinSession({ canvases: [canvas] });
