const params = new URLSearchParams(location.search);
const INSTANCE = params.get("instance");
const TOKEN = params.get("token");
const API = (path) => `${path}?instance=${encodeURIComponent(INSTANCE)}&token=${encodeURIComponent(TOKEN)}`;

const LAYERS = [
  { id: "domain", label: "Domains", color: "var(--layer-domain)" },
  { id: "endpoint", label: "Endpoints", color: "var(--layer-endpoint)" },
  { id: "route", label: "Routes", color: "var(--layer-route)" },
  { id: "originGroup", label: "Origin groups", color: "var(--layer-origin-group)" },
  { id: "origin", label: "Origins", color: "var(--layer-origin)" },
];
const LAYER_INDEX = new Map(LAYERS.map((l, i) => [l.id, i]));
const NODE_WIDTH = 232;
const COLUMN_GAP = 96;
const ROW_GAP = 12;
const COLUMN_PITCH = NODE_WIDTH + COLUMN_GAP;

const el = (id) => document.getElementById(id);
const dom = {
  profileSelect: el("profile-select"),
  search: el("search"),
  refresh: el("refresh"),
  toggleDisabled: el("toggle-disabled"),
  toggleOrphans: el("toggle-orphans"),
  meta: el("meta"),
  columns: el("columns"),
  viewport: el("viewport"),
  canvas: el("canvas"),
  canvasInner: el("canvas-inner"),
  edges: el("edges"),
  nodes: el("nodes"),
  overlay: el("overlay"),
  overlayTitle: el("overlay-title"),
  overlayBody: el("overlay-body"),
  overlayDetail: el("overlay-detail"),
  overlayAction: el("overlay-action"),
  inspectorEmpty: el("inspector-empty"),
  inspectorBody: el("inspector-body"),
  inspectorLayer: el("inspector-layer"),
  inspectorTitle: el("inspector-title"),
  inspectorSub: el("inspector-sub"),
  inspectorBadges: el("inspector-badges"),
  inspectorDetails: el("inspector-details"),
  inspectorPath: el("inspector-path"),
  ask: el("ask"),
  portal: el("portal"),
  warnings: el("warnings"),
  warningsList: el("warnings-list"),
  zoomLabel: el("zoom-label"),
};

let state = { status: { phase: "idle", message: "" }, topology: null, selectedNodeId: null, selectedProfileId: null };
let zoom = 1;
let laidOut = [];
const nodeElements = new Map();

function post(path, body) {
  return fetch(API(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).catch(() => null);
}

function activeProfile() {
  const profiles = state.topology?.profiles ?? [];
  return profiles.find((p) => p.id === state.selectedProfileId) ?? profiles[0] ?? null;
}

function matchesSearch(node, needle) {
  if (!needle) return true;
  const haystack = [node.label, node.sublabel, ...Object.values(node.details ?? {})].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(needle);
}

/**
 * Applies the toolbar filters. A node surviving the text filter keeps its whole
 * connected path visible, otherwise filtering by a hostname would strip the
 * origins that make the result meaningful.
 */
function visibleNodes(profile) {
  const needle = dom.search.value.trim().toLowerCase();
  const showDisabled = dom.toggleDisabled.checked;
  const showOrphans = dom.toggleOrphans.checked;

  const connected = new Set();
  for (const edge of profile.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  let pool = profile.nodes.filter((n) => {
    if (!showDisabled && n.state === "disabled") return false;
    if (!showOrphans && !connected.has(n.id)) return false;
    return true;
  });

  if (needle) {
    const seeds = pool.filter((n) => matchesSearch(n, needle)).map((n) => n.id);
    const keep = traverse(profile, seeds);
    pool = pool.filter((n) => keep.has(n.id));
  }
  return pool;
}

/** Collects every node reachable from `seeds` in either direction. */
function traverse(profile, seeds) {
  const upstream = new Map();
  const downstream = new Map();
  for (const edge of profile.edges) {
    if (!downstream.has(edge.from)) downstream.set(edge.from, []);
    downstream.get(edge.from).push(edge.to);
    if (!upstream.has(edge.to)) upstream.set(edge.to, []);
    upstream.get(edge.to).push(edge.from);
  }
  const seen = new Set(seeds);
  const walk = (start, adjacency) => {
    const queue = [start];
    while (queue.length) {
      const current = queue.pop();
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  };
  for (const seed of seeds) {
    walk(seed, upstream);
    walk(seed, downstream);
  }
  return seen;
}

/**
 * Orders each layer with repeated barycenter sweeps so edges between adjacent
 * columns cross as little as possible.
 */
function orderLayers(nodes, edges) {
  const columns = LAYERS.map(({ id }) =>
    nodes.filter((n) => n.layer === id).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  );

  const present = new Set(nodes.map((n) => n.id));
  const successors = new Map();
  const predecessors = new Map();
  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    if (!successors.has(edge.from)) successors.set(edge.from, []);
    successors.get(edge.from).push(edge.to);
    if (!predecessors.has(edge.to)) predecessors.set(edge.to, []);
    predecessors.get(edge.to).push(edge.from);
  }

  const positionOf = () => {
    const map = new Map();
    columns.forEach((column) => column.forEach((n, i) => map.set(n.id, i)));
    return map;
  };

  const sweep = (columnIndex, adjacency, positions) => {
    const column = columns[columnIndex];
    const scores = new Map(
      column.map((n, i) => {
        const neighbours = (adjacency.get(n.id) ?? []).map((id) => positions.get(id)).filter((v) => v !== undefined);
        return [n.id, neighbours.length ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length : i];
      }),
    );
    column.sort((a, b) => scores.get(a.id) - scores.get(b.id) || a.label.localeCompare(b.label));
  };

  for (let pass = 0; pass < 4; pass += 1) {
    let positions = positionOf();
    for (let i = 1; i < columns.length; i += 1) sweep(i, predecessors, positions);
    positions = positionOf();
    for (let i = columns.length - 2; i >= 0; i -= 1) sweep(i, successors, positions);
  }

  return columns;
}

function badgeMarkup(badges) {
  return (badges ?? [])
    .map((b) => {
      const span = document.createElement("span");
      span.className = `badge tone-${b.tone || "muted"}`;
      span.textContent = b.label;
      return span.outerHTML;
    })
    .join("");
}

function buildNodeElement(node) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `node state-${node.state || "enabled"}`;
  button.style.setProperty("--accent", LAYERS[LAYER_INDEX.get(node.layer) ?? 0].color);
  button.dataset.nodeId = node.id;

  const title = document.createElement("span");
  title.className = "node-title";
  title.textContent = node.label;
  button.append(title);

  if (node.sublabel) {
    const sub = document.createElement("span");
    sub.className = "node-sub";
    sub.textContent = node.sublabel;
    button.append(sub);
  }
  if (node.badges?.length) {
    const badges = document.createElement("span");
    badges.className = "badges";
    badges.innerHTML = badgeMarkup(node.badges.slice(0, 4));
    button.append(badges);
  }

  button.addEventListener("click", () => selectNode(node.id));
  return button;
}

function renderColumnHeads(columns) {
  dom.columns.replaceChildren(
    ...LAYERS.map((layer, i) => {
      const head = document.createElement("div");
      head.className = "column-head";
      head.style.setProperty("--dot", layer.color);
      head.dataset.column = String(i);
      head.textContent = `${layer.label} (${columns[i].length})`;
      return head;
    }),
  );
  syncColumnHeads();
}

/** Keeps the sticky column headers aligned with the zoomed, panned graph. */
function syncColumnHeads() {
  const offset = dom.viewport.scrollLeft - 24;
  for (const head of dom.columns.children) {
    const index = Number(head.dataset.column);
    head.style.transform = `translateX(${index * COLUMN_PITCH * zoom - offset}px)`;
    head.style.width = `${NODE_WIDTH * zoom}px`;
  }
}

function renderGraph() {
  const profile = activeProfile();
  nodeElements.clear();
  laidOut = [];

  if (!profile) {
    dom.nodes.replaceChildren();
    dom.edges.replaceChildren();
    dom.columns.replaceChildren();
    return;
  }

  const nodes = visibleNodes(profile);
  const columns = orderLayers(nodes, profile.edges);
  renderColumnHeads(columns);

  // Heights depend on wrapped text, so nodes are attached first and measured
  // before any vertical position is assigned.
  const fragment = document.createDocumentFragment();
  for (const column of columns) {
    for (const node of column) {
      const element = buildNodeElement(node);
      nodeElements.set(node.id, element);
      fragment.append(element);
    }
  }
  dom.nodes.replaceChildren(fragment);

  let maxHeight = 0;
  columns.forEach((column, columnIndex) => {
    let y = 0;
    for (const node of column) {
      const element = nodeElements.get(node.id);
      const height = element.offsetHeight || 56;
      const x = columnIndex * COLUMN_PITCH;
      element.style.transform = `translate(${x}px, ${y}px)`;
      laidOut.push({ node, x, y, width: NODE_WIDTH, height });
      y += height + ROW_GAP;
    }
    maxHeight = Math.max(maxHeight, y);
  });

  const width = LAYERS.length * COLUMN_PITCH - COLUMN_GAP;
  const height = Math.max(maxHeight - ROW_GAP, 120);
  dom.canvasInner.style.width = `${width}px`;
  dom.canvasInner.style.height = `${height}px`;
  dom.edges.setAttribute("viewBox", `0 0 ${width} ${height}`);
  dom.edges.setAttribute("width", width);
  dom.edges.setAttribute("height", height);

  renderEdges(profile);
  applyZoom();
  applySelection();
}

function renderEdges(profile) {
  const geometry = new Map(laidOut.map((item) => [item.node.id, item]));
  const paths = [];
  for (const edge of profile.edges) {
    const from = geometry.get(edge.from);
    const to = geometry.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const curve = Math.max(28, (x2 - x1) / 2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`);
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    paths.push(path);
  }
  dom.edges.replaceChildren(...paths);
}

function applySelection() {
  const profile = activeProfile();
  const selectedId = state.selectedNodeId;
  const selected = selectedId ? profile?.nodes.find((n) => n.id === selectedId) : null;

  if (!selected) {
    for (const element of nodeElements.values()) element.classList.remove("dim", "active", "selected");
    for (const path of dom.edges.children) path.classList.remove("dim", "active");
    dom.inspectorEmpty.hidden = false;
    dom.inspectorBody.hidden = true;
    return;
  }

  const connected = traverse(profile, [selectedId]);
  for (const [id, element] of nodeElements) {
    element.classList.toggle("dim", !connected.has(id));
    element.classList.toggle("active", connected.has(id));
    element.classList.toggle("selected", id === selectedId);
  }
  for (const path of dom.edges.children) {
    const onPath = connected.has(path.dataset.from) && connected.has(path.dataset.to);
    path.classList.toggle("active", onPath);
    path.classList.toggle("dim", !onPath);
  }

  renderInspector(profile, selected, connected);
}

function renderInspector(profile, node, connected) {
  dom.inspectorEmpty.hidden = true;
  dom.inspectorBody.hidden = false;

  const layer = LAYERS[LAYER_INDEX.get(node.layer) ?? 0];
  dom.inspectorBody.style.setProperty("--accent", layer.color);
  dom.inspectorLayer.textContent = layer.label.replace(/s$/, "");
  dom.inspectorTitle.textContent = node.label;
  dom.inspectorSub.textContent = node.sublabel || "";
  dom.inspectorSub.hidden = !node.sublabel;
  dom.inspectorBadges.innerHTML = badgeMarkup(node.badges);

  const details = document.createDocumentFragment();
  for (const [key, value] of Object.entries(node.details ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    details.append(dt, dd);
  }
  dom.inspectorDetails.replaceChildren(details);

  const grouped = LAYERS.map((l) => ({
    layer: l,
    nodes: profile.nodes.filter((n) => n.layer === l.id && connected.has(n.id)),
  })).filter((group) => group.nodes.length);

  const path = document.createDocumentFragment();
  const heading = document.createElement("h3");
  heading.textContent = "Connected path";
  path.append(heading);
  const list = document.createElement("ol");
  for (const group of grouped) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "path-layer";
    label.textContent = `${group.layer.label}: `;
    item.append(label, document.createTextNode(group.nodes.map((n) => n.label).join(", ")));
    list.append(item);
  }
  path.append(list);
  dom.inspectorPath.replaceChildren(path);

  if (node.azureId && profile.portalUrl) {
    dom.portal.hidden = false;
    dom.portal.href = `https://portal.azure.com/#@/resource${node.azureId}`;
  } else {
    dom.portal.hidden = true;
  }
}

function selectNode(nodeId) {
  state.selectedNodeId = state.selectedNodeId === nodeId ? null : nodeId;
  applySelection();
  post("/api/select", { nodeId: state.selectedNodeId, profileId: activeProfile()?.id ?? null });
}

function renderProfiles() {
  const profiles = state.topology?.profiles ?? [];
  const current = activeProfile();
  dom.profileSelect.replaceChildren(
    ...profiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name} · ${profile.kind === "classic" ? "Classic" : profile.sku.replace("_AzureFrontDoor", "")}`;
      option.selected = profile.id === current?.id;
      return option;
    }),
  );
  dom.profileSelect.disabled = profiles.length <= 1;
}

function renderMeta() {
  const profile = activeProfile();
  const topology = state.topology;
  if (!profile || !topology) {
    dom.meta.textContent = "";
    dom.warnings.hidden = true;
    return;
  }
  const counts = profile.counts;
  const scanned = new Date(topology.generatedAt);
  dom.meta.textContent = [
    `${counts.domains} domains · ${counts.endpoints} endpoints · ${counts.routes} routes · ${counts.originGroups} origin groups · ${counts.origins} origins`,
    profile.subscriptionName ? `${profile.subscriptionName} / ${profile.resourceGroup}` : "",
    topology.source === "agent" ? "provided by agent" : `scanned ${scanned.toLocaleTimeString()}`,
  ]
    .filter(Boolean)
    .join("  —  ");

  const findings = [...(profile.warnings ?? []), ...(topology.errors ?? [])];
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
  const hasData = (state.topology?.profiles ?? []).length > 0;
  dom.refresh.disabled = phase === "loading";
  dom.refresh.textContent = phase === "loading" ? "Scanning…" : "Rescan Azure";

  if (phase === "loading" && !hasData) {
    dom.overlay.hidden = false;
    dom.overlayTitle.textContent = "Scanning Azure…";
    dom.overlayBody.textContent = message || "Reading Front Door configuration through Azure Resource Manager.";
    dom.overlayDetail.hidden = true;
    dom.overlayAction.hidden = true;
    return;
  }
  if (phase === "error" && !hasData) {
    dom.overlay.hidden = false;
    dom.overlayTitle.textContent =
      code === "az_not_installed" ? "Azure CLI not found" : code === "az_not_logged_in" ? "Sign in to Azure" : "Could not load topology";
    dom.overlayBody.textContent = message || "Something went wrong while contacting Azure.";
    dom.overlayDetail.hidden = !detail;
    dom.overlayDetail.textContent = detail || "";
    dom.overlayAction.hidden = false;
    return;
  }
  if (phase !== "loading" && !hasData) {
    dom.overlay.hidden = false;
    dom.overlayTitle.textContent = "No Front Door profiles";
    dom.overlayBody.textContent = message || "No Azure Front Door profiles were found for the signed-in account.";
    dom.overlayDetail.hidden = true;
    dom.overlayAction.hidden = false;
    return;
  }
  dom.overlay.hidden = true;
}

function render() {
  renderProfiles();
  renderOverlay();
  renderGraph();
  renderMeta();
}

function applyZoom() {
  dom.canvasInner.style.transform = `scale(${zoom})`;
  const width = parseFloat(dom.canvasInner.style.width || "0");
  const height = parseFloat(dom.canvasInner.style.height || "0");
  dom.canvas.style.width = `${width * zoom + 48}px`;
  dom.canvas.style.height = `${height * zoom + 48}px`;
  dom.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  syncColumnHeads();
}

function setZoom(next) {
  zoom = Math.min(2, Math.max(0.25, Number(next.toFixed(2))));
  applyZoom();
}

function fitToViewport() {
  const width = parseFloat(dom.canvasInner.style.width || "0");
  if (!width) return;
  setZoom(Math.min(1, (dom.viewport.clientWidth - 64) / width));
}

function enablePanning() {
  let origin = null;
  dom.viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".node") || event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY, left: dom.viewport.scrollLeft, top: dom.viewport.scrollTop };
    dom.viewport.setPointerCapture(event.pointerId);
    dom.viewport.classList.add("panning");
  });
  dom.viewport.addEventListener("pointermove", (event) => {
    if (!origin) return;
    dom.viewport.scrollLeft = origin.left - (event.clientX - origin.x);
    dom.viewport.scrollTop = origin.top - (event.clientY - origin.y);
  });
  const stop = (event) => {
    if (!origin) return;
    origin = null;
    dom.viewport.releasePointerCapture?.(event.pointerId);
    dom.viewport.classList.remove("panning");
  };
  dom.viewport.addEventListener("pointerup", stop);
  dom.viewport.addEventListener("pointercancel", stop);

  dom.viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? 1.1 : 0.9));
    },
    { passive: false },
  );
}

function applyServerState(next) {
  state = { ...state, ...next };
  render();
}

function connect() {
  const source = new EventSource(API("/events"));
  source.addEventListener("state", (event) => applyServerState(JSON.parse(event.data)));
  source.addEventListener("status", (event) => {
    state.status = JSON.parse(event.data);
    renderOverlay();
  });
  source.addEventListener("topology", (event) => {
    const payload = JSON.parse(event.data);
    state.topology = payload.topology;
    state.status = payload.status;
    if (!payload.topology?.profiles?.some((p) => p.id === state.selectedProfileId)) {
      state.selectedProfileId = payload.topology?.profiles?.[0]?.id ?? null;
    }
    if (!payload.topology?.profiles?.some((p) => p.nodes.some((n) => n.id === state.selectedNodeId))) {
      state.selectedNodeId = null;
    }
    render();
    fitToViewport();
  });
  source.addEventListener("selection", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.profileId) state.selectedProfileId = payload.profileId;
    state.selectedNodeId = payload.nodeId;
    applySelection();
  });
  source.onerror = () => {
    /* EventSource reconnects on its own; the next `state` frame resyncs. */
  };
}

dom.profileSelect.addEventListener("change", () => {
  state.selectedProfileId = dom.profileSelect.value;
  state.selectedNodeId = null;
  render();
  fitToViewport();
});

let searchTimer;
dom.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderGraph(), 160);
});

for (const toggle of [dom.toggleDisabled, dom.toggleOrphans]) {
  toggle.addEventListener("change", () => renderGraph());
}

dom.refresh.addEventListener("click", () => post("/api/refresh", {}));
dom.overlayAction.addEventListener("click", () => post("/api/refresh", {}));
el("zoom-in").addEventListener("click", () => setZoom(zoom * 1.15));
el("zoom-out").addEventListener("click", () => setZoom(zoom / 1.15));
el("zoom-fit").addEventListener("click", fitToViewport);

dom.ask.addEventListener("click", () => {
  const profile = activeProfile();
  if (!profile || !state.selectedNodeId) return;
  dom.ask.disabled = true;
  post("/api/ask", { profileId: profile.id, nodeId: state.selectedNodeId }).finally(() => {
    dom.ask.disabled = false;
  });
});

window.addEventListener("resize", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderGraph(), 200);
});

enablePanning();
dom.viewport.addEventListener("scroll", syncColumnHeads, { passive: true });
fetch(API("/api/state"))
  .then((r) => r.json())
  .then((initial) => {
    applyServerState(initial);
    fitToViewport();
  })
  .catch(() => {});
connect();
