import { listSubscriptions, resourceGraphQuery, shortId } from "./azure.mjs";

/**
 * Resource families used to colour and group the map. The first matching
 * prefix wins, so more specific provider paths must be listed first.
 */
export const CATEGORIES = [
  { id: "compute", label: "Compute", color: "var(--cat-compute)" },
  { id: "web", label: "Web & apps", color: "var(--cat-web)" },
  { id: "containers", label: "Containers", color: "var(--cat-containers)" },
  { id: "data", label: "Databases", color: "var(--cat-data)" },
  { id: "storage", label: "Storage", color: "var(--cat-storage)" },
  { id: "networking", label: "Networking", color: "var(--cat-networking)" },
  { id: "security", label: "Security & identity", color: "var(--cat-security)" },
  { id: "ai", label: "AI & search", color: "var(--cat-ai)" },
  { id: "integration", label: "Integration", color: "var(--cat-integration)" },
  { id: "analytics", label: "Analytics", color: "var(--cat-analytics)" },
  { id: "observability", label: "Observability", color: "var(--cat-observability)" },
  { id: "devops", label: "DevOps", color: "var(--cat-devops)" },
  { id: "management", label: "Management", color: "var(--cat-management)" },
  { id: "other", label: "Other", color: "var(--cat-other)" },
];

const CATEGORY_RULES = [
  ["microsoft.compute/virtualmachines", "compute"],
  ["microsoft.compute/virtualmachinescalesets", "compute"],
  ["microsoft.compute/disks", "storage"],
  ["microsoft.compute/snapshots", "storage"],
  ["microsoft.compute/images", "compute"],
  ["microsoft.compute/", "compute"],
  ["microsoft.classiccompute/", "compute"],
  ["microsoft.web/sites", "web"],
  ["microsoft.web/serverfarms", "web"],
  ["microsoft.web/staticsites", "web"],
  ["microsoft.web/", "web"],
  ["microsoft.app/", "containers"],
  ["microsoft.containerservice/", "containers"],
  ["microsoft.containerregistry/", "containers"],
  ["microsoft.containerinstance/", "containers"],
  ["microsoft.sql/", "data"],
  ["microsoft.dbfor", "data"],
  ["microsoft.documentdb/", "data"],
  ["microsoft.cache/", "data"],
  ["microsoft.datamigration/", "data"],
  ["microsoft.storage/", "storage"],
  ["microsoft.netapp/", "storage"],
  ["microsoft.storagesync/", "storage"],
  ["microsoft.network/", "networking"],
  ["microsoft.cdn/", "networking"],
  ["microsoft.classicnetwork/", "networking"],
  ["microsoft.keyvault/", "security"],
  ["microsoft.managedidentity/", "security"],
  ["microsoft.security/", "security"],
  ["microsoft.aadiam/", "security"],
  ["microsoft.cognitiveservices/", "ai"],
  ["microsoft.machinelearningservices/", "ai"],
  ["microsoft.search/", "ai"],
  ["microsoft.botservice/", "ai"],
  ["microsoft.logic/", "integration"],
  ["microsoft.apimanagement/", "integration"],
  ["microsoft.eventgrid/", "integration"],
  ["microsoft.servicebus/", "integration"],
  ["microsoft.relay/", "integration"],
  ["microsoft.eventhub/", "analytics"],
  ["microsoft.datafactory/", "analytics"],
  ["microsoft.synapse/", "analytics"],
  ["microsoft.databricks/", "analytics"],
  ["microsoft.streamanalytics/", "analytics"],
  ["microsoft.kusto/", "analytics"],
  ["microsoft.purview/", "analytics"],
  ["microsoft.insights/", "observability"],
  ["microsoft.operationalinsights/", "observability"],
  ["microsoft.operationsmanagement/", "observability"],
  ["microsoft.alertsmanagement/", "observability"],
  ["microsoft.monitor/", "observability"],
  ["microsoft.devtestlab/", "devops"],
  ["microsoft.visualstudio/", "devops"],
  ["microsoft.devcenter/", "devops"],
  ["microsoft.automation/", "management"],
  ["microsoft.recoveryservices/", "management"],
  ["microsoft.resources/", "management"],
  ["microsoft.portal/", "management"],
  ["microsoft.maintenance/", "management"],
  ["microsoft.migrate/", "management"],
];

export function categorize(resourceType) {
  const type = String(resourceType || "").toLowerCase();
  for (const [prefix, category] of CATEGORY_RULES) {
    if (type.startsWith(prefix)) return category;
  }
  return "other";
}

/** `Microsoft.Web/sites` -> `sites`; `Microsoft.Sql/servers/databases` -> `servers/databases`. */
export function displayType(resourceType) {
  const parts = String(resourceType || "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : resourceType || "unknown";
}

export function providerOf(resourceType) {
  return String(resourceType || "").split("/")[0] || "unknown";
}

const RESOURCE_QUERY = `
resources
| project id, name, type, kind, location, resourceGroup, subscriptionId, tags, sku, managedBy
`;

const GROUP_QUERY = `
resourcecontainers
| where type =~ 'microsoft.resources/subscriptions/resourcegroups'
| project id, name, location, subscriptionId, tags
`;

function tally(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function buildGroup(groupRow, resources, subscriptionNames) {
  const subscriptionId = groupRow.subscriptionId;
  const mapped = resources
    .map((r) => {
      const category = categorize(r.type);
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        shortType: displayType(r.type),
        provider: providerOf(r.type),
        category,
        location: r.location || "global",
        kind: r.kind || null,
        sku: r.sku?.name || r.sku?.tier || null,
        tags: r.tags && typeof r.tags === "object" ? r.tags : {},
        // `managedBy` marks resources owned by another resource (AKS node
        // pools, managed disks), which are noise in a hand-maintained map.
        managedBy: r.managedBy ? shortId(r.managedBy) : null,
        managedById: r.managedBy || null,
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.shortType.localeCompare(b.shortType) || a.name.localeCompare(b.name));

  const untagged = mapped.filter((r) => Object.keys(r.tags).length === 0).length;
  const warnings = [];
  if (mapped.length === 0) warnings.push(`Resource group ${groupRow.name} is empty.`);
  if (mapped.length && untagged === mapped.length) warnings.push(`No resource in ${groupRow.name} carries any tag.`);
  const locations = tally(mapped, (r) => r.location);
  if (locations.length > 3) {
    warnings.push(`${groupRow.name} spans ${locations.length} regions, which can add cross-region egress cost and latency.`);
  }

  return {
    id: groupRow.id,
    name: groupRow.name,
    location: groupRow.location,
    subscriptionId,
    subscriptionName: subscriptionNames.get(String(subscriptionId).toLowerCase()) || "Unknown subscription",
    tags: groupRow.tags && typeof groupRow.tags === "object" ? groupRow.tags : {},
    portalUrl: `https://portal.azure.com/#@/resource${groupRow.id}/overview`,
    resourceCount: mapped.length,
    untaggedCount: untagged,
    managedCount: mapped.filter((r) => r.managedById).length,
    categories: tally(mapped, (r) => r.category).map(([id, count]) => ({ id, count })),
    types: tally(mapped, (r) => r.shortType).map(([type, count]) => ({ type, count })),
    locations: locations.map(([location, count]) => ({ location, count })),
    resources: mapped,
    warnings,
  };
}

function buildStats(groups) {
  const resources = groups.flatMap((g) => g.resources);
  return {
    totalGroups: groups.length,
    totalResources: resources.length,
    emptyGroups: groups.filter((g) => g.resourceCount === 0).length,
    untaggedResources: resources.filter((r) => Object.keys(r.tags).length === 0).length,
    byCategory: tally(resources, (r) => r.category).map(([id, count]) => ({ id, count })),
    byLocation: tally(resources, (r) => r.location).map(([location, count]) => ({ location, count })),
    byType: tally(resources, (r) => r.shortType)
      .slice(0, 25)
      .map(([type, count]) => ({ type, count })),
  };
}

/**
 * Builds a per-resource-group map of every resource the signed-in identity can
 * read. Resource Graph is used for both queries so a tenant-wide scan stays a
 * couple of requests rather than one call per resource group.
 */
export async function discoverResourceMap({ subscriptionIds, groupFilter, onProgress } = {}) {
  const report = (message) => onProgress?.(message);

  report("Resolving subscriptions…");
  const allSubscriptions = await listSubscriptions();
  const wanted = subscriptionIds?.length
    ? allSubscriptions.filter((s) =>
        subscriptionIds.some((id) => id.toLowerCase() === s.id.toLowerCase() || id.toLowerCase() === s.name.toLowerCase()),
      )
    : allSubscriptions;

  if (wanted.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      source: "live",
      subscriptions: [],
      groups: [],
      stats: buildStats([]),
      errors: [subscriptionIds?.length ? "None of the requested subscriptions were found." : "No enabled subscriptions are visible to this account."],
    };
  }

  const subscriptionIdList = wanted.map((s) => s.id);
  const subscriptionNames = new Map(wanted.map((s) => [s.id.toLowerCase(), s.name]));

  report(`Listing resource groups across ${wanted.length} subscription(s)…`);
  const groupRows = await resourceGraphQuery(GROUP_QUERY, { subscriptions: subscriptionIdList });

  report(`Listing resources across ${groupRows.length} resource group(s)…`);
  const resourceRows = await resourceGraphQuery(RESOURCE_QUERY, { subscriptions: subscriptionIdList });

  const byGroupKey = new Map();
  for (const row of resourceRows) {
    const key = `${String(row.subscriptionId).toLowerCase()}/${String(row.resourceGroup || "").toLowerCase()}`;
    if (!byGroupKey.has(key)) byGroupKey.set(key, []);
    byGroupKey.get(key).push(row);
  }

  const needle = groupFilter?.trim().toLowerCase();
  const groups = groupRows
    .filter((row) => !needle || row.name.toLowerCase().includes(needle))
    .map((row) => buildGroup(row, byGroupKey.get(`${String(row.subscriptionId).toLowerCase()}/${row.name.toLowerCase()}`) ?? [], subscriptionNames))
    .sort((a, b) => b.resourceCount - a.resourceCount || a.name.localeCompare(b.name));

  const errors = [];
  if (groups.length === 0) {
    errors.push(
      needle
        ? `No resource group matched "${groupFilter}" in ${wanted.length} subscription(s).`
        : `No resource groups were found in ${wanted.length} subscription(s).`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "live",
    subscriptions: wanted.map((s) => ({ id: s.id, name: s.name })),
    groups,
    stats: buildStats(groups),
    errors,
  };
}

/** Normalizes an agent-supplied map so pushed data renders like a live scan. */
export function normalizeAgentMap(input) {
  const groups = (input.groups ?? []).map((group, index) => {
    const resources = (group.resources ?? []).map((r, i) => {
      const type = r.type || "Unknown/resources";
      return {
        id: r.id || `${group.name || "rg"}-resource-${i}`,
        name: r.name,
        type,
        shortType: displayType(type),
        provider: providerOf(type),
        category: r.category && CATEGORIES.some((c) => c.id === r.category) ? r.category : categorize(type),
        location: r.location || "unknown",
        kind: r.kind ?? null,
        sku: r.sku ?? null,
        tags: r.tags && typeof r.tags === "object" ? r.tags : {},
        managedBy: null,
        managedById: null,
      };
    });
    const subscriptionName = group.subscriptionName || "Provided by agent";
    return {
      id: group.id || `agent-rg-${index}`,
      name: group.name || `Resource group ${index + 1}`,
      location: group.location || "unknown",
      // The canvas filters by subscription ID, so agent data without one gets a
      // stable ID derived from the display name.
      subscriptionId: group.subscriptionId || `agent:${subscriptionName}`,
      subscriptionName,
      tags: group.tags && typeof group.tags === "object" ? group.tags : {},
      portalUrl: group.id?.startsWith("/subscriptions/") ? `https://portal.azure.com/#@/resource${group.id}/overview` : null,
      resourceCount: resources.length,
      untaggedCount: resources.filter((r) => Object.keys(r.tags).length === 0).length,
      managedCount: 0,
      categories: tally(resources, (r) => r.category).map(([id, count]) => ({ id, count })),
      types: tally(resources, (r) => r.shortType).map(([type, count]) => ({ type, count })),
      locations: tally(resources, (r) => r.location).map(([location, count]) => ({ location, count })),
      resources,
      warnings: group.warnings ?? [],
    };
  });

  const subscriptions = [];
  for (const group of groups) {
    if (!subscriptions.some((s) => s.id === group.subscriptionId)) {
      subscriptions.push({ id: group.subscriptionId, name: group.subscriptionName });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "agent",
    subscriptions,
    groups: groups.sort((a, b) => b.resourceCount - a.resourceCount || a.name.localeCompare(b.name)),
    stats: buildStats(groups),
    errors: [],
  };
}
