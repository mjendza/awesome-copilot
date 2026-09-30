# Azure Resource Group Map

Canvas extension that renders every Azure resource group as a card of colour-coded resource tiles.

## How it gets data

`azure.mjs` shells out to `az account get-access-token` exactly once, caches the token until it expires, and then talks to Azure Resource Manager over `fetch`. The whole estate is fetched with two Azure Resource Graph queries — one for `resourcecontainers`, one for `resources` — rather than a call per resource group, so a tenant-wide scan stays fast.

Every request is a read. Nothing is written back to Azure.

Resources are bucketed into families (compute, web, containers, databases, storage, networking, security, AI, integration, analytics, observability, DevOps, management, other) by matching the ARM provider path in `resources.mjs`; the first matching prefix wins, so more specific paths are listed first.

## Files

| File | Role |
| --- | --- |
| `extension.mjs` | Canvas declaration, actions, instance store, agent prompts. |
| `azure.mjs` | Azure CLI token bootstrap, ARM/Resource Graph client, paging and retries. |
| `resources.mjs` | Resource Graph queries, family classification, per-group aggregation. |
| `server.mjs` | Loopback HTTP server, per-instance token auth, SSE. |
| `public/` | Canvas UI: card grid, family legend, regrouping, inspector. |
| `demo-data.mjs` | Fictional Contoso estate in the `load_resource_map` shape. |
| `harness.mjs` | Runs the canvas standalone, without the Copilot runtime. |

## Local development

```bash
node harness.mjs          # scan the signed-in Azure account
node harness.mjs --demo   # render the Contoso fixture, no Azure needed
```

Both print a loopback URL you can open in a browser.
