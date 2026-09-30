# Azure Front Door Topology

Canvas extension that renders an Azure Front Door as a layered request-path graph.

```text
Domains → Endpoints → Routes → Origin groups → Origins
```

## How it gets data

`azure.mjs` shells out to `az account get-access-token` exactly once, caches the token until it expires, and then talks to Azure Resource Manager over `fetch`. That keeps a full profile crawl to a handful of HTTP requests instead of one `az` process per ARM call, and it needs no Azure CLI extensions.

- Front Door profiles are located with an Azure Resource Graph query across every readable subscription.
- Standard/Premium profiles (`Microsoft.Cdn/profiles`) are expanded via `afdEndpoints`, `routes`, `customDomains`, `originGroups`, `origins`, `ruleSets` and `securityPolicies`.
- Classic Front Doors (`Microsoft.Network/frontDoors`) come back in a single GET and are mapped onto the same five-column model.

Every request is a read. Nothing is written back to Azure.

## Files

| File | Role |
| --- | --- |
| `extension.mjs` | Canvas declaration, actions, instance store, agent prompts. |
| `azure.mjs` | Azure CLI token bootstrap, ARM/Resource Graph client, paging and retries. |
| `frontdoor.mjs` | Discovery and the normalized node/edge topology model. |
| `server.mjs` | Loopback HTTP server, per-instance token auth, SSE. |
| `public/` | Canvas UI: layered graph, barycenter ordering, pan/zoom, inspector. |
| `demo-data.mjs` | Fictional Contoso topology in the `load_topology` shape. |
| `harness.mjs` | Runs the canvas standalone, without the Copilot runtime. |

## Local development

```bash
node harness.mjs          # scan the signed-in Azure account
node harness.mjs --demo   # render the Contoso fixture, no Azure needed
```

Both print a loopback URL you can open in a browser.
