import { armGet, armList, listSubscriptions, parseResourceId, resourceGraphQuery, shortId } from "./azure.mjs";

const AFD_API = "2024-02-01";
const CLASSIC_API = "2021-06-01";
const AFD_SKUS = new Set(["standard_azurefrontdoor", "premium_azurefrontdoor"]);

/** Resource Graph is only used to locate profiles; the topology itself comes from ARM. */
const PROFILE_QUERY = `
resources
| where type =~ 'microsoft.cdn/profiles' or type =~ 'microsoft.network/frontdoors'
| project id, name, type, sku, location, resourceGroup, subscriptionId, tags, properties
`;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function enabled(state) {
  return String(state || "").toLowerCase() === "enabled";
}

function node(id, layer, label, extra = {}) {
  return { id, layer, label, badges: [], details: {}, state: "enabled", ...extra };
}

function pushEdge(edges, from, to, kind, label) {
  if (!from || !to) return;
  const id = `${from}->${to}:${kind}`;
  if (edges.some((e) => e.id === id)) return;
  edges.push({ id, from, to, kind, label: label || null });
}

function buildAfdTopology(profile, data) {
  const { endpoints, customDomains, originGroups, ruleSets, securityPolicies, routesByEndpoint, originsByGroup } = data;
  const nodes = [];
  const edges = [];
  const warnings = [];

  const ruleSetNames = new Map(ruleSets.map((rs) => [rs.id.toLowerCase(), rs.name]));

  // WAF associations are keyed by custom-domain / endpoint resource id so the
  // policy can be rendered as a badge on whichever domain it protects.
  const wafByTarget = new Map();
  for (const policy of securityPolicies) {
    const wafId = policy.properties?.parameters?.wafPolicy?.id;
    if (!wafId) continue;
    const wafName = shortId(wafId);
    for (const association of policy.properties?.parameters?.associations ?? []) {
      for (const domain of association.domains ?? []) {
        const key = String(domain.id || "").toLowerCase();
        if (!key) continue;
        if (!wafByTarget.has(key)) wafByTarget.set(key, new Set());
        wafByTarget.get(key).add(wafName);
      }
    }
  }

  const domainNodeByAzureId = new Map();
  for (const domain of customDomains) {
    const props = domain.properties ?? {};
    const id = `domain:${domain.id}`;
    const validation = props.domainValidationState || "Unknown";
    const waf = [...(wafByTarget.get(String(domain.id).toLowerCase()) ?? [])];
    const n = node(id, "domain", props.hostName || domain.name, {
      sublabel: domain.name,
      azureId: domain.id,
      state: /approved|pending/i.test(validation) ? (/approved/i.test(validation) ? "enabled" : "warning") : "warning",
      badges: [
        { label: validation, tone: /approved/i.test(validation) ? "ok" : "warn" },
        ...(props.tlsSettings?.certificateType
          ? [{ label: props.tlsSettings.certificateType.replace(/Certificate$/i, ""), tone: "muted" }]
          : []),
        ...waf.map((w) => ({ label: `WAF ${w}`, tone: "accent" })),
      ],
      details: {
        Hostname: props.hostName,
        "Validation state": validation,
        "Certificate type": props.tlsSettings?.certificateType,
        "Minimum TLS": props.tlsSettings?.minimumTlsVersion,
        "Azure DNS zone": props.azureDnsZone?.id ? shortId(props.azureDnsZone.id) : "Not managed",
        "WAF policies": waf.length ? waf.join(", ") : "None",
      },
    });
    nodes.push(n);
    domainNodeByAzureId.set(String(domain.id).toLowerCase(), n);
  }

  const originGroupNodeByAzureId = new Map();
  for (const group of originGroups) {
    const props = group.properties ?? {};
    const lb = props.loadBalancingSettings ?? {};
    const probe = props.healthProbeSettings ?? {};
    const id = `originGroup:${group.id}`;
    const n = node(id, "originGroup", group.name, {
      azureId: group.id,
      sublabel: probe.probePath ? `probe ${probe.probeProtocol || ""} ${probe.probePath}`.trim() : "no health probe",
      badges: [
        ...(enabled(props.sessionAffinityState) ? [{ label: "session affinity", tone: "accent" }] : []),
        ...(probe.probePath ? [] : [{ label: "no probe", tone: "warn" }]),
      ],
      details: {
        "Sample size": lb.sampleSize,
        "Successful samples required": lb.successfulSamplesRequired,
        "Additional latency (ms)": lb.additionalLatencyInMilliseconds,
        "Probe path": probe.probePath,
        "Probe protocol": probe.probeProtocol,
        "Probe interval (s)": probe.probeIntervalInSeconds,
        "Session affinity": props.sessionAffinityState,
      },
    });
    nodes.push(n);
    originGroupNodeByAzureId.set(String(group.id).toLowerCase(), n);

    for (const origin of originsByGroup.get(group.id) ?? []) {
      const oProps = origin.properties ?? {};
      const originId = `origin:${origin.id}`;
      nodes.push(
        node(originId, "origin", oProps.hostName || origin.name, {
          azureId: origin.id,
          sublabel: origin.name,
          state: enabled(oProps.enabledState) ? "enabled" : "disabled",
          badges: [
            { label: `priority ${oProps.priority ?? "?"}`, tone: "muted" },
            { label: `weight ${oProps.weight ?? "?"}`, tone: "muted" },
            ...(oProps.sharedPrivateLinkResource ? [{ label: "private link", tone: "accent" }] : []),
            ...(oProps.enforceCertificateNameCheck === false ? [{ label: "cert check off", tone: "warn" }] : []),
          ],
          details: {
            Hostname: oProps.hostName,
            "Origin host header": oProps.originHostHeader,
            "HTTP port": oProps.httpPort,
            "HTTPS port": oProps.httpsPort,
            Priority: oProps.priority,
            Weight: oProps.weight,
            Enabled: oProps.enabledState,
            "Certificate name check": String(oProps.enforceCertificateNameCheck ?? ""),
            "Private link": oProps.sharedPrivateLinkResource?.privateLink?.id
              ? shortId(oProps.sharedPrivateLinkResource.privateLink.id)
              : "No",
          },
        }),
      );
      pushEdge(edges, id, originId, "origin");
    }
  }

  for (const endpoint of endpoints) {
    const props = endpoint.properties ?? {};
    const endpointNodeId = `endpoint:${endpoint.id}`;
    const routes = routesByEndpoint.get(endpoint.id) ?? [];
    nodes.push(
      node(endpointNodeId, "endpoint", endpoint.name, {
        azureId: endpoint.id,
        sublabel: props.hostName,
        state: enabled(props.enabledState) ? "enabled" : "disabled",
        badges: [{ label: `${routes.length} route${routes.length === 1 ? "" : "s"}`, tone: "muted" }],
        details: {
          "Default hostname": props.hostName,
          Enabled: props.enabledState,
          "Provisioning state": props.provisioningState,
          Location: endpoint.location,
        },
      }),
    );

    // The auto-generated `*.azurefd.net` hostname is a real entry point, so it
    // is modelled as a domain node whenever a route links to it.
    const defaultDomainNodeId = `domain:default:${endpoint.id}`;
    let defaultDomainAdded = false;

    for (const route of routes) {
      const rProps = route.properties ?? {};
      const routeNodeId = `route:${route.id}`;
      const patterns = rProps.patternsToMatch ?? [];
      const attachedRuleSets = (rProps.ruleSets ?? [])
        .map((rs) => ruleSetNames.get(String(rs.id).toLowerCase()) || shortId(rs.id))
        .filter(Boolean);
      const cache = rProps.cacheConfiguration;

      nodes.push(
        node(routeNodeId, "route", route.name, {
          azureId: route.id,
          sublabel: patterns.join(", ") || "/*",
          state: enabled(rProps.enabledState) ? "enabled" : "disabled",
          badges: [
            { label: rProps.forwardingProtocol || "MatchRequest", tone: "muted" },
            ...(enabled(rProps.httpsRedirect) ? [{ label: "HTTPS redirect", tone: "accent" }] : []),
            ...(cache ? [{ label: "cached", tone: "ok" }] : []),
            ...attachedRuleSets.map((rs) => ({ label: `rules: ${rs}`, tone: "accent" })),
          ],
          details: {
            Patterns: patterns.join(", "),
            "Supported protocols": (rProps.supportedProtocols ?? []).join(", "),
            "Forwarding protocol": rProps.forwardingProtocol,
            "HTTPS redirect": rProps.httpsRedirect,
            "Link to default domain": rProps.linkToDefaultDomain,
            "Origin path": rProps.originPath || "(none)",
            Caching: cache ? `${cache.queryStringCachingBehavior || "enabled"}` : "Disabled",
            "Compression": cache?.compressionSettings?.isCompressionEnabled ? "Enabled" : "Disabled",
            "Rule sets": attachedRuleSets.join(", ") || "None",
            Enabled: rProps.enabledState,
          },
        }),
      );

      pushEdge(edges, endpointNodeId, routeNodeId, "route");

      const linkedDomains = rProps.customDomains ?? [];
      for (const domain of linkedDomains) {
        const domainNode = domainNodeByAzureId.get(String(domain.id).toLowerCase());
        if (domainNode) {
          pushEdge(edges, domainNode.id, endpointNodeId, "domain");
        } else {
          warnings.push(`Route ${route.name} references custom domain ${shortId(domain.id)} which was not returned by ARM.`);
        }
      }

      if (enabled(rProps.linkToDefaultDomain)) {
        if (!defaultDomainAdded) {
          nodes.push(
            node(defaultDomainNodeId, "domain", props.hostName || `${endpoint.name}.azurefd.net`, {
              sublabel: "Azure-managed default domain",
              badges: [{ label: "default", tone: "muted" }],
              details: { Hostname: props.hostName, Type: "Auto-generated Front Door domain" },
            }),
          );
          defaultDomainAdded = true;
        }
        pushEdge(edges, defaultDomainNodeId, endpointNodeId, "domain");
      }

      const originGroupId = rProps.originGroup?.id;
      if (originGroupId) {
        const groupNode = originGroupNodeByAzureId.get(String(originGroupId).toLowerCase());
        if (groupNode) {
          pushEdge(edges, routeNodeId, groupNode.id, "originGroup");
        } else {
          warnings.push(`Route ${route.name} references origin group ${shortId(originGroupId)} which was not returned by ARM.`);
        }
      }
    }
  }

  // Custom domains that exist but are not referenced by any route are dead
  // weight and a common misconfiguration, so flag them explicitly.
  for (const [, domainNode] of domainNodeByAzureId) {
    if (!edges.some((e) => e.from === domainNode.id)) {
      domainNode.state = "warning";
      domainNode.badges.push({ label: "unrouted", tone: "warn" });
      warnings.push(`Custom domain ${domainNode.label} is not attached to any route.`);
    }
  }
  for (const n of nodes) {
    if (n.layer === "originGroup" && !edges.some((e) => e.to === n.id)) {
      n.badges.push({ label: "unrouted", tone: "warn" });
      warnings.push(`Origin group ${n.label} is not targeted by any route.`);
    }
  }

  return { nodes, edges, warnings };
}

function buildClassicTopology(frontDoor) {
  const props = frontDoor.properties ?? {};
  const nodes = [];
  const edges = [];
  const warnings = [];

  const fdNodeId = `endpoint:${frontDoor.id}`;
  nodes.push(
    node(fdNodeId, "endpoint", frontDoor.name, {
      azureId: frontDoor.id,
      sublabel: props.cname || `${frontDoor.name}.azurefd.net`,
      state: enabled(props.enabledState) ? "enabled" : "disabled",
      details: {
        CNAME: props.cname,
        Enabled: props.enabledState,
        "Provisioning state": props.provisioningState,
        "Friendly name": props.friendlyName,
      },
    }),
  );

  const frontendById = new Map();
  for (const frontend of props.frontendEndpoints ?? []) {
    const fProps = frontend.properties ?? {};
    const id = `domain:${frontend.id}`;
    const waf = fProps.webApplicationFirewallPolicyLink?.id;
    const n = node(id, "domain", fProps.hostName || frontend.name, {
      azureId: frontend.id,
      sublabel: frontend.name,
      badges: [
        ...(waf ? [{ label: `WAF ${shortId(waf)}`, tone: "accent" }] : []),
        ...(enabled(fProps.sessionAffinityEnabledState) ? [{ label: "session affinity", tone: "accent" }] : []),
      ],
      details: {
        Hostname: fProps.hostName,
        "Session affinity": fProps.sessionAffinityEnabledState,
        "WAF policy": waf ? shortId(waf) : "None",
      },
    });
    nodes.push(n);
    frontendById.set(String(frontend.id).toLowerCase(), n);
    pushEdge(edges, id, fdNodeId, "domain");
  }

  const poolById = new Map();
  for (const pool of props.backendPools ?? []) {
    const pProps = pool.properties ?? {};
    const id = `originGroup:${pool.id}`;
    const n = node(id, "originGroup", pool.name, {
      azureId: pool.id,
      sublabel: `${(pProps.backends ?? []).length} backend(s)`,
      details: {
        "Load balancing": shortId(pProps.loadBalancingSettings?.id),
        "Health probe": shortId(pProps.healthProbeSettings?.id),
      },
    });
    nodes.push(n);
    poolById.set(String(pool.id).toLowerCase(), n);

    for (const [index, backend] of (pProps.backends ?? []).entries()) {
      const backendId = `origin:${pool.id}/backends/${index}`;
      nodes.push(
        node(backendId, "origin", backend.address, {
          sublabel: backend.backendHostHeader || backend.address,
          state: enabled(backend.enabledState) ? "enabled" : "disabled",
          badges: [
            { label: `priority ${backend.priority ?? "?"}`, tone: "muted" },
            { label: `weight ${backend.weight ?? "?"}`, tone: "muted" },
            ...(backend.privateLinkResourceId ? [{ label: "private link", tone: "accent" }] : []),
          ],
          details: {
            Address: backend.address,
            "Backend host header": backend.backendHostHeader,
            "HTTP port": backend.httpPort,
            "HTTPS port": backend.httpsPort,
            Priority: backend.priority,
            Weight: backend.weight,
            Enabled: backend.enabledState,
          },
        }),
      );
      pushEdge(edges, id, backendId, "origin");
    }
  }

  for (const rule of props.routingRules ?? []) {
    const rProps = rule.properties ?? {};
    const routeNodeId = `route:${rule.id}`;
    const config = rProps.routeConfiguration ?? {};
    const isRedirect = /RedirectConfiguration/i.test(config["@odata.type"] || "");
    const patterns = rProps.patternsToMatch ?? [];

    nodes.push(
      node(routeNodeId, "route", rule.name, {
        azureId: rule.id,
        sublabel: patterns.join(", ") || "/*",
        state: enabled(rProps.enabledState) ? "enabled" : "disabled",
        badges: [
          { label: isRedirect ? "redirect" : config.forwardingProtocol || "forward", tone: isRedirect ? "accent" : "muted" },
          ...(config.cacheConfiguration ? [{ label: "cached", tone: "ok" }] : []),
        ],
        details: {
          Patterns: patterns.join(", "),
          "Accepted protocols": (rProps.acceptedProtocols ?? []).join(", "),
          Type: isRedirect ? "Redirect" : "Forward",
          "Forwarding protocol": config.forwardingProtocol,
          "Custom forwarding path": config.customForwardingPath || "(none)",
          "Redirect target": isRedirect
            ? `${config.redirectProtocol || ""} ${config.customHost || ""}${config.customPath || ""}`.trim()
            : undefined,
          Enabled: rProps.enabledState,
        },
      }),
    );

    pushEdge(edges, fdNodeId, routeNodeId, "route");

    for (const frontend of rProps.frontendEndpoints ?? []) {
      if (!frontendById.has(String(frontend.id).toLowerCase())) {
        warnings.push(`Routing rule ${rule.name} references unknown frontend ${shortId(frontend.id)}.`);
      }
    }

    if (isRedirect) {
      const redirectNodeId = `originGroup:redirect:${rule.id}`;
      nodes.push(
        node(redirectNodeId, "originGroup", "Redirect", {
          sublabel: `${config.redirectProtocol || ""} ${config.customHost || "(same host)"}`.trim(),
          badges: [{ label: config.redirectType || "Found", tone: "accent" }],
          details: {
            "Redirect type": config.redirectType,
            "Redirect protocol": config.redirectProtocol,
            "Custom host": config.customHost,
            "Custom path": config.customPath,
          },
        }),
      );
      pushEdge(edges, routeNodeId, redirectNodeId, "originGroup");
    } else {
      const poolNode = poolById.get(String(config.backendPool?.id || "").toLowerCase());
      if (poolNode) {
        pushEdge(edges, routeNodeId, poolNode.id, "originGroup");
      } else if (config.backendPool?.id) {
        warnings.push(`Routing rule ${rule.name} references unknown backend pool ${shortId(config.backendPool.id)}.`);
      }
    }
  }

  return { nodes, edges, warnings };
}

function summarize(nodes) {
  const counts = { domains: 0, endpoints: 0, routes: 0, originGroups: 0, origins: 0 };
  for (const n of nodes) {
    if (n.layer === "domain") counts.domains += 1;
    else if (n.layer === "endpoint") counts.endpoints += 1;
    else if (n.layer === "route") counts.routes += 1;
    else if (n.layer === "originGroup") counts.originGroups += 1;
    else if (n.layer === "origin") counts.origins += 1;
  }
  return counts;
}

async function loadAfdProfile(profileId) {
  const [endpoints, customDomains, originGroups, ruleSets, securityPolicies] = await Promise.all([
    armList(`${profileId}/afdEndpoints`, AFD_API),
    armList(`${profileId}/customDomains`, AFD_API),
    armList(`${profileId}/originGroups`, AFD_API),
    armList(`${profileId}/ruleSets`, AFD_API).catch(() => []),
    armList(`${profileId}/securityPolicies`, AFD_API).catch(() => []),
  ]);

  const routeLists = await mapWithConcurrency(endpoints, 6, (endpoint) =>
    armList(`${endpoint.id}/routes`, AFD_API).catch(() => []),
  );
  const originLists = await mapWithConcurrency(originGroups, 6, (group) =>
    armList(`${group.id}/origins`, AFD_API).catch(() => []),
  );

  return {
    endpoints,
    customDomains,
    originGroups,
    ruleSets,
    securityPolicies,
    routesByEndpoint: new Map(endpoints.map((e, i) => [e.id, routeLists[i]])),
    originsByGroup: new Map(originGroups.map((g, i) => [g.id, originLists[i]])),
  };
}

/**
 * Discovers every Azure Front Door (Standard/Premium and classic) the signed-in
 * identity can read and returns a normalized, layered topology graph.
 */
export async function discoverFrontDoors({ subscriptionIds, nameFilter, onProgress } = {}) {
  const report = (message) => onProgress?.(message);

  report("Resolving subscriptions…");
  const allSubscriptions = await listSubscriptions();
  const wanted = subscriptionIds?.length
    ? allSubscriptions.filter((s) => subscriptionIds.some((id) => id.toLowerCase() === s.id.toLowerCase() || id.toLowerCase() === s.name.toLowerCase()))
    : allSubscriptions;

  if (wanted.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      source: "live",
      subscriptions: [],
      profiles: [],
      errors: [subscriptionIds?.length ? "None of the requested subscriptions were found." : "No enabled subscriptions are visible to this account."],
    };
  }

  report(`Scanning ${wanted.length} subscription(s) for Front Door resources…`);
  const subscriptionNames = new Map(wanted.map((s) => [s.id.toLowerCase(), s.name]));
  const discovered = await resourceGraphQuery(PROFILE_QUERY, { subscriptions: wanted.map((s) => s.id) });

  const candidates = discovered.filter((row) => {
    const type = String(row.type || "").toLowerCase();
    if (type === "microsoft.network/frontdoors") return true;
    return type === "microsoft.cdn/profiles" && AFD_SKUS.has(String(row.sku?.name || "").toLowerCase());
  });

  const filtered = nameFilter
    ? candidates.filter((row) => row.name.toLowerCase().includes(nameFilter.toLowerCase()))
    : candidates;

  if (filtered.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      source: "live",
      subscriptions: wanted,
      profiles: [],
      errors: [
        nameFilter
          ? `No Front Door profile matched "${nameFilter}" in ${wanted.length} subscription(s).`
          : `No Azure Front Door profiles were found in ${wanted.length} subscription(s).`,
      ],
    };
  }

  const errors = [];
  const profiles = await mapWithConcurrency(filtered, 3, async (row, index) => {
    const isClassic = String(row.type).toLowerCase() === "microsoft.network/frontdoors";
    report(`Loading ${row.name} (${index + 1}/${filtered.length})…`);
    try {
      const topology = isClassic
        ? buildClassicTopology(await armGet(row.id, CLASSIC_API))
        : buildAfdTopology(row, await loadAfdProfile(row.id));
      const { subscriptionId, resourceGroup } = parseResourceId(row.id);
      return {
        id: row.id,
        name: row.name,
        kind: isClassic ? "classic" : "afd",
        sku: row.sku?.name || (isClassic ? "Classic_AzureFrontDoor" : "Unknown"),
        location: row.location,
        resourceGroup: row.resourceGroup || resourceGroup,
        subscriptionId: row.subscriptionId || subscriptionId,
        subscriptionName: subscriptionNames.get(String(row.subscriptionId || subscriptionId).toLowerCase()) || "Unknown subscription",
        portalUrl: `https://portal.azure.com/#@/resource${row.id}`,
        counts: summarize(topology.nodes),
        nodes: topology.nodes,
        edges: topology.edges,
        warnings: topology.warnings,
      };
    } catch (err) {
      errors.push(`${row.name}: ${err.message}`);
      return null;
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    source: "live",
    subscriptions: wanted,
    profiles: profiles.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
    errors,
  };
}

/**
 * Normalizes an agent-supplied topology so a pushed graph renders identically
 * to a discovered one.
 */
export function normalizeAgentTopology(input) {
  const profiles = (input.profiles ?? []).map((profile, profileIndex) => {
    const nodes = (profile.nodes ?? []).map((n, i) =>
      node(n.id || `${profile.name || "profile"}-${n.layer}-${i}`, n.layer, n.label, {
        sublabel: n.sublabel ?? null,
        state: n.state || "enabled",
        badges: Array.isArray(n.badges)
          ? n.badges.map((b) => (typeof b === "string" ? { label: b, tone: "muted" } : { label: b.label, tone: b.tone || "muted" }))
          : [],
        details: n.details && typeof n.details === "object" ? n.details : {},
        azureId: n.azureId ?? null,
      }),
    );
    const known = new Set(nodes.map((n) => n.id));
    const edges = [];
    for (const edge of profile.edges ?? []) {
      if (!known.has(edge.from) || !known.has(edge.to)) continue;
      pushEdge(edges, edge.from, edge.to, edge.kind || "link", edge.label);
    }
    return {
      id: profile.id || `agent-profile-${profileIndex}`,
      name: profile.name || `Front Door ${profileIndex + 1}`,
      kind: profile.kind === "classic" ? "classic" : "afd",
      sku: profile.sku || "Provided by agent",
      location: profile.location || "",
      resourceGroup: profile.resourceGroup || "",
      subscriptionId: profile.subscriptionId || "",
      subscriptionName: profile.subscriptionName || "Provided by agent",
      portalUrl: profile.id?.startsWith("/subscriptions/") ? `https://portal.azure.com/#@/resource${profile.id}` : null,
      counts: summarize(nodes),
      nodes,
      edges,
      warnings: profile.warnings ?? [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    source: "agent",
    subscriptions: [],
    profiles,
    errors: [],
  };
}

export const LAYERS = [
  { id: "domain", label: "Domains" },
  { id: "endpoint", label: "Endpoints" },
  { id: "route", label: "Routes" },
  { id: "originGroup", label: "Origin groups" },
  { id: "origin", label: "Origins" },
];
