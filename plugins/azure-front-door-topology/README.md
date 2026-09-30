# Azure Front Door Topology Plugin

Map an Azure Front Door end to end in a canvas: custom domains and endpoints through routes to origin groups and origins, with WAF, TLS, caching and health-probe detail.

The canvas reads Azure Resource Manager directly using the access token from your existing `az login` session, so no extra credentials or MCP servers are involved. Every call is read-only.

## What it shows

Five columns tracing the request path, with edges linking each hop:

`Domains → Endpoints → Routes → Origin groups → Origins`

Selecting any node dims everything that is not on its path, so you can answer "where does `shop.contoso.com` actually land?" in one click. Both Front Door Standard/Premium (`Microsoft.Cdn/profiles`) and classic Front Door (`Microsoft.Network/frontDoors`) are supported.

The canvas also surfaces findings as it builds the graph — unrouted custom domains, origin groups no route targets, origin groups without a health probe, and domains stuck in validation.

## Requirements

- [Azure CLI](https://aka.ms/azure-cli) installed and signed in (`az login`)
- Read access to the subscriptions you want to scan

## Installation

```bash
copilot plugin install azure-front-door-topology@awesome-copilot
```

## Canvas actions

| Action | Purpose |
| --- | --- |
| `scan_front_doors` | Scan Azure and render every Front Door profile found. |
| `get_topology` | Return the rendered graph (nodes, edges, configuration) for analysis. |
| `trace_path` | Trace a hostname, route, origin group or origin and highlight it. |
| `load_topology` | Render a topology supplied by the agent instead of scanning Azure. |
| `focus_node` | Highlight one node and dim everything off its path. |

## Source

This plugin is part of [Awesome Copilot](https://github.com/github/awesome-copilot).

## License

MIT
