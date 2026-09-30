// Demo fixture used only to render preview assets from the real UI. Not shipped.
const domains = [
  ["www.contoso.com", "Approved", true],
  ["shop.contoso.com", "Approved", true],
  ["api.contoso.com", "Approved", true],
  ["static.contoso.com", "Approved", false],
  ["legacy.contoso.com", "Pending", false],
];

const nodes = [];
const edges = [];
const edge = (from, to) => edges.push({ from, to });

for (const [host, validation, waf] of domains) {
  nodes.push({
    id: `domain:${host}`,
    layer: "domain",
    label: host,
    sublabel: host.split(".")[0],
    state: validation === "Approved" ? "enabled" : "warning",
    badges: [
      { label: validation, tone: validation === "Approved" ? "ok" : "warn" },
      { label: "ManagedCertificate", tone: "muted" },
      ...(waf ? [{ label: "WAF wafContosoProd", tone: "accent" }] : []),
    ],
    details: {
      Hostname: host,
      "Validation state": validation,
      "Certificate type": "ManagedCertificate",
      "Minimum TLS": "TLS1_2",
      "WAF policies": waf ? "wafContosoProd" : "None",
    },
  });
}

const endpoints = [
  ["afd-contoso-web", "afd-contoso-web-h8e2.z01.azurefd.net"],
  ["afd-contoso-api", "afd-contoso-api-k41d.z01.azurefd.net"],
  ["afd-contoso-static", "afd-contoso-static-b7q9.z01.azurefd.net"],
];
for (const [name, host] of endpoints) {
  nodes.push({
    id: `endpoint:${name}`,
    layer: "endpoint",
    label: name,
    sublabel: host,
    badges: [{ label: "3 routes", tone: "muted" }],
    details: { "Default hostname": host, Enabled: "Enabled", "Provisioning state": "Succeeded", Location: "Global" },
  });
}

const routes = [
  ["web-default", "afd-contoso-web", ["/*"], "og-web-app", ["www.contoso.com", "shop.contoso.com"], true, false],
  ["web-static", "afd-contoso-web", ["/assets/*", "/media/*"], "og-static-assets", ["www.contoso.com"], true, true],
  ["checkout", "afd-contoso-web", ["/checkout/*"], "og-checkout", ["shop.contoso.com"], true, false],
  ["api-v2", "afd-contoso-api", ["/api/v2/*"], "og-api-backend", ["api.contoso.com"], true, false],
  ["api-v1-legacy", "afd-contoso-api", ["/api/v1/*"], "og-legacy-api", ["legacy.contoso.com"], false, false],
  ["cdn-images", "afd-contoso-static", ["/img/*"], "og-static-assets", ["static.contoso.com"], true, true],
];
for (const [name, endpoint, patterns, originGroup, linkedDomains, https, cached] of routes) {
  const id = `route:${name}`;
  nodes.push({
    id,
    layer: "route",
    label: name,
    sublabel: patterns.join(", "),
    state: name.includes("legacy") ? "disabled" : "enabled",
    badges: [
      { label: "HttpsOnly", tone: "muted" },
      ...(https ? [{ label: "HTTPS redirect", tone: "accent" }] : []),
      ...(cached ? [{ label: "cached", tone: "ok" }] : []),
      ...(name === "checkout" ? [{ label: "rules: rsSecurityHeaders", tone: "accent" }] : []),
    ],
    details: {
      Patterns: patterns.join(", "),
      "Supported protocols": "Http, Https",
      "Forwarding protocol": "HttpsOnly",
      "HTTPS redirect": https ? "Enabled" : "Disabled",
      Caching: cached ? "IgnoreQueryString" : "Disabled",
      Compression: cached ? "Enabled" : "Disabled",
    },
  });
  edge(`endpoint:${endpoint}`, id);
  edge(id, `originGroup:${originGroup}`);
  for (const domain of linkedDomains) edge(`domain:${domain}`, `endpoint:${endpoint}`);
}

const originGroups = [
  ["og-web-app", "probe Https /health", true],
  ["og-static-assets", "probe Https /", false],
  ["og-api-backend", "probe Https /healthz", true],
  ["og-checkout", "probe Https /ready", true],
  ["og-legacy-api", "no health probe", false],
];
for (const [name, probe, affinity] of originGroups) {
  nodes.push({
    id: `originGroup:${name}`,
    layer: "originGroup",
    label: name,
    sublabel: probe,
    badges: [
      ...(affinity ? [{ label: "session affinity", tone: "accent" }] : []),
      ...(probe.startsWith("no") ? [{ label: "no probe", tone: "warn" }] : []),
    ],
    details: { "Sample size": 4, "Successful samples required": 3, "Probe path": probe.replace("probe Https ", ""), "Probe protocol": "Https" },
  });
}

const origins = [
  ["og-web-app", "app-contoso-web-neu.azurewebsites.net", 1, 1000, true],
  ["og-web-app", "app-contoso-web-weu.azurewebsites.net", 2, 1000, true],
  ["og-static-assets", "stcontosoassets.z6.web.core.windows.net", 1, 1000, true],
  ["og-api-backend", "apim-contoso-prod.azure-api.net", 1, 1000, true],
  ["og-api-backend", "app-contoso-api-neu.azurewebsites.net", 2, 500, true],
  ["og-checkout", "ca-contoso-checkout.northeurope.azurecontainerapps.io", 1, 1000, true],
  ["og-legacy-api", "legacy-api.contoso.internal", 1, 1000, false],
];
for (const [group, host, priority, weight, enabled] of origins) {
  const id = `origin:${group}/${host}`;
  nodes.push({
    id,
    layer: "origin",
    label: host,
    sublabel: group.replace("og-", ""),
    state: enabled ? "enabled" : "disabled",
    badges: [
      { label: `priority ${priority}`, tone: "muted" },
      { label: `weight ${weight}`, tone: "muted" },
      ...(host.includes("internal") ? [{ label: "cert check off", tone: "warn" }] : []),
    ],
    details: { Hostname: host, "Origin host header": host, "HTTP port": 80, "HTTPS port": 443, Priority: priority, Weight: weight },
  });
  edge(`originGroup:${group}`, id);
}

export const demoTopology = {
  profiles: [
    {
      id: "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-contoso-edge-prod/providers/Microsoft.Cdn/profiles/afd-contoso-prod",
      name: "afd-contoso-prod",
      kind: "afd",
      sku: "Premium_AzureFrontDoor",
      location: "Global",
      resourceGroup: "rg-contoso-edge-prod",
      subscriptionName: "Contoso Production",
      warnings: ["Custom domain legacy.contoso.com is attached to a disabled route.", "Origin group og-legacy-api has no health probe configured."],
      nodes,
      edges,
    },
  ],
};
