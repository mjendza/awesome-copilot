const params = new URLSearchParams(location.search);
const INSTANCE = params.get("instance");
const TOKEN = params.get("token");
const API = (path) => `${path}?instance=${encodeURIComponent(INSTANCE)}&token=${encodeURIComponent(TOKEN)}`;

const CATEGORIES = [
  { id: "compute", label: "Compute" },
  { id: "web", label: "Web & apps" },
  { id: "containers", label: "Containers" },
  { id: "data", label: "Databases" },
  { id: "storage", label: "Storage" },
  { id: "networking", label: "Networking" },
  { id: "security", label: "Security & identity" },
  { id: "ai", label: "AI & search" },
  { id: "integration", label: "Integration" },
  { id: "analytics", label: "Analytics" },
  { id: "observability", label: "Observability" },
  { id: "devops", label: "DevOps" },
  { id: "management", label: "Management" },
  { id: "other", label: "Other" },
];
const CATEGORY_LABEL = new Map(CATEGORIES.map((c) => [c.id, c.label]));
const categoryColor = (id) => `var(--cat-${id}, var(--cat-other))`;
const TILE_LIMIT = 28;

const el = (id) => document.getElementById(id);
const dom = {
  subscriptionSelect: el("subscription-select"),
  groupBy: el("group-by"),
  sortBy: el("sort-by"),
  search: el("search"),
  refresh: el("refresh"),
  legend: el("legend"),
  summary: el("summary"),
  grid: el("grid"),
  overlay: el("overlay"),
  overlayTitle: el("overlay-title"),
  overlayBody: el("overlay-body"),
  overlayDetail: el("overlay-detail"),
  overlayAction: el("overlay-action"),
  inspectorEmpty: el("inspector-empty"),
  inspectorBody: el("inspector-body"),
  inspectorKind: el("inspector-kind"),
  inspectorTitle: el("inspector-title"),
  inspectorSub: el("inspector-sub"),
  inspectorDetails: el("inspector-details"),
  inspectorBreakdown: el("inspector-breakdown"),
  ask: el("ask"),
  portal: el("portal"),
  warnings: el("warnings"),
  warningsList: el("warnings-list"),
};

let state = { status: { phase: "idle", message: "" }, map: null, selection: null };
let mutedCategories = new Set();
let expanded = new Set();

function post(path, body) {
  return fetch(API(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).catch(() => null);
}

function matches(resource, needle) {
  if (!needle) return true;
  const haystack = [
    resource.name,
    resource.type,
    resource.shortType,
    resource.location,
    resource.kind,
    resource.sku,
    ...Object.entries(resource.tags ?? {}).flat(),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Applies the subscription, family and text filters to the raw scan result. */
function filteredGroups() {
  const map = state.map;
  if (!map) return [];
  const subscription = dom.subscriptionSelect.value;
  const needle = dom.search.value.trim().toLowerCase();

  return map.groups
    .filter((group) => subscription === "all" || group.subscriptionId === subscription)
    .map((group) => ({
      ...group,
      resources: group.resources.filter((r) => !mutedCategories.has(r.category) && matches(r, needle)),
    }))
    .filter((group) => group.resources.length > 0 || (!needle && mutedCategories.size === 0));
}

/**
 * Re-buckets the filtered resources into the cards the user asked for. The
 * resource-group view keeps the real group metadata; the others synthesise
 * cards so the same card component can render every mode.
 */
function buildCards(groups) {
  const mode = dom.groupBy.value;
  if (mode === "resourceGroup") {
    return groups.map((group) => ({
      key: group.id,
      kind: "resourceGroup",
      title: group.name,
      subtitle: `${group.subscriptionName} · ${group.location}`,
      resources: group.resources,
      untagged: group.resources.filter((r) => Object.keys(r.tags ?? {}).length === 0).length,
      source: group,
    }));
  }

  const keyOf = {
    category: (r) => CATEGORY_LABEL.get(r.category) ?? r.category,
    location: (r) => r.location,
    type: (r) => r.shortType,
  }[mode];

  const buckets = new Map();
  for (const group of groups) {
    for (const resource of group.resources) {
      const key = keyOf(resource);
      if (!buckets.has(key)) buckets.set(key, { resources: [], groups: new Set() });
      const bucket = buckets.get(key);
      bucket.resources.push({ ...resource, resourceGroupName: group.name });
      bucket.groups.add(group.name);
    }
  }

  return [...buckets.entries()].map(([title, bucket]) => ({
    key: `${mode}:${title}`,
    kind: mode,
    title,
    subtitle: `${bucket.groups.size} resource group${bucket.groups.size === 1 ? "" : "s"}`,
    resources: bucket.resources,
    untagged: bucket.resources.filter((r) => Object.keys(r.tags ?? {}).length === 0).length,
    source: null,
  }));
}

function sortCards(cards) {
  const mode = dom.sortBy.value;
  return cards.sort((a, b) => {
    if (mode === "name") return a.title.localeCompare(b.title, undefined, { numeric: true });
    if (mode === "untagged") return b.untagged - a.untagged || b.resources.length - a.resources.length;
    return b.resources.length - a.resources.length || a.title.localeCompare(b.title);
  });
}

function renderLegend() {
  const counts = new Map((state.map?.stats.byCategory ?? []).map((c) => [c.id, c.count]));
  dom.legend.replaceChildren(
    ...CATEGORIES.filter((category) => counts.get(category.id)).map((category) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `legend-chip${mutedCategories.has(category.id) ? " off" : ""}`;
      chip.style.setProperty("--dot", categoryColor(category.id));
      chip.setAttribute("aria-pressed", String(!mutedCategories.has(category.id)));
      chip.textContent = `${category.label} ${counts.get(category.id)}`;
      chip.addEventListener("click", () => {
        if (mutedCategories.has(category.id)) mutedCategories.delete(category.id);
        else mutedCategories.add(category.id);
        renderLegend();
        renderGrid();
      });
      return chip;
    }),
  );
}

function stat(value, label) {
  const wrapper = document.createElement("div");
  wrapper.className = "stat";
  const v = document.createElement("span");
  v.className = "stat-value";
  v.textContent = value;
  const l = document.createElement("span");
  l.className = "stat-label";
  l.textContent = label;
  wrapper.append(v, l);
  return wrapper;
}

function renderSummary(cards) {
  const map = state.map;
  if (!map) {
    dom.summary.replaceChildren();
    return;
  }
  const visible = cards.flatMap((c) => c.resources);
  const regions = new Set(visible.map((r) => r.location));
  const untagged = visible.filter((r) => Object.keys(r.tags ?? {}).length === 0).length;
  dom.summary.replaceChildren(
    stat(String(cards.length), dom.groupBy.value === "resourceGroup" ? "Resource groups" : "Buckets"),
    stat(String(visible.length), "Resources"),
    stat(String(regions.size), "Regions"),
    stat(String(untagged), "Untagged"),
    stat(map.source === "agent" ? "agent" : new Date(map.generatedAt).toLocaleTimeString(), map.source === "agent" ? "Data source" : "Last scan"),
  );
}

function renderCategoryBar(resources) {
  const bar = document.createElement("div");
  bar.className = "bar";
  const counts = new Map();
  for (const resource of resources) counts.set(resource.category, (counts.get(resource.category) ?? 0) + 1);
  for (const category of CATEGORIES) {
    const count = counts.get(category.id);
    if (!count) continue;
    const segment = document.createElement("span");
    segment.style.width = `${(count / resources.length) * 100}%`;
    segment.style.background = categoryColor(category.id);
    segment.title = `${category.label}: ${count}`;
    bar.append(segment);
  }
  return bar;
}

function renderTile(resource, card) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = `tile${resource.managedById ? " managed" : ""}`;
  tile.style.setProperty("--dot", categoryColor(resource.category));
  tile.title = `${resource.name}\n${resource.type}\n${resource.location}${resource.sku ? `\nSKU: ${resource.sku}` : ""}`;
  if (state.selection?.kind === "resource" && state.selection.id === resource.id) tile.classList.add("selected");

  const name = document.createElement("span");
  name.className = "tile-name";
  name.textContent = resource.name;
  const type = document.createElement("span");
  type.className = "tile-type";
  type.textContent = card.kind === "type" ? resource.resourceGroupName ?? resource.location : resource.shortType;
  tile.append(name, type);

  tile.addEventListener("click", () => select({ kind: "resource", id: resource.id, cardKey: card.key }));
  return tile;
}

function renderCard(card) {
  const element = document.createElement("article");
  element.className = "rg-card";
  if (state.selection?.kind === "group" && state.selection.id === card.key) element.classList.add("selected");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "rg-head";
  const titleRow = document.createElement("div");
  titleRow.className = "rg-title";
  const name = document.createElement("span");
  name.className = "rg-name";
  name.textContent = card.title;
  const count = document.createElement("span");
  count.className = "rg-count";
  count.textContent = `${card.resources.length}`;
  titleRow.append(name, count);
  const subtitle = document.createElement("span");
  subtitle.className = "rg-sub";
  subtitle.textContent = card.subtitle;
  head.append(titleRow, subtitle);
  head.addEventListener("click", () => select({ kind: "group", id: card.key }));
  element.append(head);

  if (card.resources.length) {
    element.append(renderCategoryBar(card.resources));

    const tiles = document.createElement("div");
    tiles.className = "tiles";
    const isExpanded = expanded.has(card.key);
    const shown = isExpanded ? card.resources : card.resources.slice(0, TILE_LIMIT);
    for (const resource of shown) tiles.append(renderTile(resource, card));

    if (card.resources.length > TILE_LIMIT) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "more";
      more.textContent = isExpanded ? "Show less" : `+${card.resources.length - TILE_LIMIT} more`;
      more.addEventListener("click", () => {
        if (isExpanded) expanded.delete(card.key);
        else expanded.add(card.key);
        renderGrid();
      });
      tiles.append(more);
    }
    element.append(tiles);
  }

  const foot = document.createElement("div");
  foot.className = "rg-foot";
  const regions = new Set(card.resources.map((r) => r.location));
  if (regions.size > 1) foot.append(pill(`${regions.size} regions`, regions.size > 3));
  if (card.untagged) foot.append(pill(`${card.untagged} untagged`, card.untagged === card.resources.length));
  if (!card.resources.length) foot.append(pill("empty", true));
  const managed = card.resources.filter((r) => r.managedById).length;
  if (managed) foot.append(pill(`${managed} managed`, false));
  if (foot.childElementCount) element.append(foot);

  return element;
}

function pill(text, isWarning) {
  const span = document.createElement("span");
  span.className = `pill${isWarning ? " warn" : ""}`;
  span.textContent = text;
  return span;
}

let cards = [];

function renderGrid() {
  cards = sortCards(buildCards(filteredGroups()));
  renderSummary(cards);

  if (!cards.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = state.map ? "No resources match the current filters." : "";
    dom.grid.replaceChildren(empty);
    return;
  }
  dom.grid.replaceChildren(...cards.map(renderCard));
  renderInspector();
}

function select(next) {
  const same = state.selection && state.selection.kind === next.kind && state.selection.id === next.id;
  state.selection = same ? null : next;
  renderGrid();
  post("/api/select", { selection: state.selection });
}

function findSelection() {
  if (!state.selection) return null;
  if (state.selection.kind === "group") {
    const card = cards.find((c) => c.key === state.selection.id);
    return card ? { kind: "group", card } : null;
  }
  for (const card of cards) {
    const resource = card.resources.find((r) => r.id === state.selection.id);
    if (resource) return { kind: "resource", resource, card };
  }
  return null;
}

function breakdownSection(title, rows, colorOf) {
  const section = document.createDocumentFragment();
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  const total = rows.reduce((sum, row) => sum + row.count, 0) || 1;
  for (const row of rows.slice(0, 12)) {
    const line = document.createElement("div");
    line.className = "breakdown-row";
    const label = document.createElement("span");
    label.textContent = row.label;
    const value = document.createElement("b");
    value.textContent = String(row.count);
    const meter = document.createElement("div");
    meter.className = "breakdown-meter";
    meter.style.setProperty("--dot", colorOf ? colorOf(row) : "var(--cat-other)");
    const fill = document.createElement("span");
    fill.style.width = `${(row.count / total) * 100}%`;
    meter.append(fill);
    line.append(label, value, meter);
    section.append(line);
  }
  return section;
}

function renderInspector() {
  const selection = findSelection();
  if (!selection) {
    dom.inspectorEmpty.hidden = false;
    dom.inspectorBody.hidden = true;
    return;
  }
  dom.inspectorEmpty.hidden = true;
  dom.inspectorBody.hidden = false;

  if (selection.kind === "resource") {
    const { resource } = selection;
    dom.inspectorBody.style.setProperty("--accent", categoryColor(resource.category));
    dom.inspectorKind.textContent = CATEGORY_LABEL.get(resource.category) ?? "Resource";
    dom.inspectorTitle.textContent = resource.name;
    dom.inspectorSub.textContent = resource.type;
    dom.inspectorSub.hidden = false;

    const details = document.createDocumentFragment();
    const rows = {
      Region: resource.location,
      Kind: resource.kind,
      SKU: resource.sku,
      "Resource group": resource.resourceGroupName ?? selection.card.title,
      "Managed by": resource.managedBy,
      Tags: Object.keys(resource.tags ?? {}).length
        ? Object.entries(resource.tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "none",
    };
    for (const [key, value] of Object.entries(rows)) {
      if (!value) continue;
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      details.append(dt, dd);
    }
    dom.inspectorDetails.replaceChildren(details);
    dom.inspectorBreakdown.replaceChildren();
    dom.portal.hidden = !resource.id.startsWith("/subscriptions/");
    dom.portal.href = `https://portal.azure.com/#@/resource${resource.id}`;
    return;
  }

  const { card } = selection;
  dom.inspectorBody.style.setProperty("--accent", "var(--cat-compute)");
  dom.inspectorKind.textContent = card.kind === "resourceGroup" ? "Resource group" : dom.groupBy.selectedOptions[0].textContent;
  dom.inspectorTitle.textContent = card.title;
  dom.inspectorSub.textContent = card.subtitle;
  dom.inspectorSub.hidden = false;

  const details = document.createDocumentFragment();
  const regions = new Set(card.resources.map((r) => r.location));
  const rows = {
    Resources: card.resources.length,
    Regions: [...regions].join(", ") || "—",
    Untagged: `${card.untagged} of ${card.resources.length}`,
    "Resource group tags":
      card.source && Object.keys(card.source.tags ?? {}).length
        ? Object.entries(card.source.tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : card.source
          ? "none"
          : null,
  };
  for (const [key, value] of Object.entries(rows)) {
    if (value === null || value === undefined) continue;
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    details.append(dt, dd);
  }
  dom.inspectorDetails.replaceChildren(details);

  const byCategory = new Map();
  const byType = new Map();
  for (const resource of card.resources) {
    byCategory.set(resource.category, (byCategory.get(resource.category) ?? 0) + 1);
    byType.set(resource.shortType, (byType.get(resource.shortType) ?? 0) + 1);
  }
  const breakdown = document.createDocumentFragment();
  breakdown.append(
    breakdownSection(
      "By family",
      [...byCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => ({ label: CATEGORY_LABEL.get(id) ?? id, count, id })),
      (row) => categoryColor(row.id),
    ),
  );
  breakdown.append(
    breakdownSection(
      "By type",
      [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ label: type, count })),
    ),
  );
  dom.inspectorBreakdown.replaceChildren(breakdown);

  dom.portal.hidden = !card.source?.portalUrl;
  if (card.source?.portalUrl) dom.portal.href = card.source.portalUrl;
}

function renderSubscriptions() {
  const subscriptions = state.map?.subscriptions ?? [];
  const current = dom.subscriptionSelect.value || "all";
  const options = [{ id: "all", name: `All subscriptions (${subscriptions.length})` }, ...subscriptions];
  dom.subscriptionSelect.replaceChildren(
    ...options.map((subscription) => {
      const option = document.createElement("option");
      option.value = subscription.id;
      option.textContent = subscription.name;
      option.selected = subscription.id === current;
      return option;
    }),
  );
  dom.subscriptionSelect.disabled = subscriptions.length === 0;
}

function renderWarnings() {
  const map = state.map;
  const findings = [...(map?.groups ?? []).flatMap((g) => g.warnings), ...(map?.errors ?? [])];
  dom.warnings.hidden = findings.length === 0;
  dom.warningsList.replaceChildren(
    ...findings.slice(0, 20).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
}

function renderOverlay() {
  const { phase, message, detail, code } = state.status ?? {};
  const hasData = (state.map?.groups ?? []).length > 0;
  dom.refresh.disabled = phase === "loading";
  dom.refresh.textContent = phase === "loading" ? "Scanning…" : "Rescan Azure";

  if (phase === "loading" && !hasData) {
    dom.overlay.hidden = false;
    dom.overlayTitle.textContent = "Scanning Azure…";
    dom.overlayBody.textContent = message || "Reading resource groups through Azure Resource Graph.";
    dom.overlayDetail.hidden = true;
    dom.overlayAction.hidden = true;
    return;
  }
  if (phase === "error" && !hasData) {
    dom.overlay.hidden = false;
    dom.overlayTitle.textContent =
      code === "az_not_installed" ? "Azure CLI not found" : code === "az_not_logged_in" ? "Sign in to Azure" : "Could not load resources";
    dom.overlayBody.textContent = message || "Something went wrong while contacting Azure.";
    dom.overlayDetail.hidden = !detail;
    dom.overlayDetail.textContent = detail || "";
    dom.overlayAction.hidden = false;
    return;
  }
  if (phase !== "loading" && !hasData) {
    dom.overlay.hidden = false;
    dom.overlayTitle.textContent = "No resource groups";
    dom.overlayBody.textContent = message || "No resource groups were found for the signed-in account.";
    dom.overlayDetail.hidden = true;
    dom.overlayAction.hidden = false;
    return;
  }
  dom.overlay.hidden = true;
}

function applyView(view) {
  if (!view) return;
  if (view.groupBy) dom.groupBy.value = view.groupBy;
  if (view.search !== undefined && view.search !== null) dom.search.value = view.search;
  if (Array.isArray(view.categories)) {
    mutedCategories = new Set(CATEGORIES.map((c) => c.id).filter((id) => !view.categories.includes(id)));
  }
}

function render() {
  renderSubscriptions();
  renderLegend();
  renderOverlay();
  renderGrid();
  renderWarnings();
}

function connect() {
  const source = new EventSource(API("/events"));
  source.addEventListener("state", (event) => {
    state = { ...state, ...JSON.parse(event.data) };
    applyView(state.view);
    render();
  });
  source.addEventListener("status", (event) => {
    state.status = JSON.parse(event.data);
    renderOverlay();
  });
  source.addEventListener("map", (event) => {
    const payload = JSON.parse(event.data);
    state.map = payload.map;
    state.status = payload.status;
    expanded = new Set();
    render();
  });
  source.addEventListener("selection", (event) => {
    state.selection = JSON.parse(event.data).selection ?? null;
    renderGrid();
  });
  source.addEventListener("filters", (event) => {
    const view = JSON.parse(event.data);
    state.view = { ...(state.view ?? {}), ...view };
    applyView(view);
    renderLegend();
    renderGrid();
  });
  source.onerror = () => {
    /* EventSource reconnects on its own; the next `state` frame resyncs. */
  };
}

for (const control of [dom.subscriptionSelect, dom.groupBy, dom.sortBy]) {
  control.addEventListener("change", () => {
    state.selection = null;
    expanded = new Set();
    renderGrid();
  });
}

let searchTimer;
dom.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 160);
});

dom.refresh.addEventListener("click", () => post("/api/refresh", {}));
dom.overlayAction.addEventListener("click", () => post("/api/refresh", {}));

dom.ask.addEventListener("click", () => {
  if (!state.selection) return;
  const selection = findSelection();
  if (!selection) return;
  dom.ask.disabled = true;
  post("/api/ask", {
    kind: selection.kind,
    id: state.selection.id,
    cardTitle: selection.card.title,
    groupBy: dom.groupBy.value,
  }).finally(() => {
    dom.ask.disabled = false;
  });
});

fetch(API("/api/state"))
  .then((r) => r.json())
  .then((initial) => {
    state = { ...state, ...initial };
    applyView(state.view);
    render();
  })
  .catch(() => {});
connect();
