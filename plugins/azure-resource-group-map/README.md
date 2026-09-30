# Azure Resource Group Map Plugin

Visual map of every Azure resource group and the resources inside it, colour coded by resource family with region, SKU, tag-coverage and governance findings.

The canvas reads Azure Resource Graph directly using the access token from your existing `az login` session, so no extra credentials or MCP servers are involved. Every call is read-only, and a whole tenant is fetched in two queries rather than one call per resource group.

## What it shows

Each resource group is a card holding a tile per resource, tinted by resource family (compute, web, containers, databases, storage, networking, security, AI, integration, analytics, observability, DevOps, management). A stacked bar on each card gives the family mix at a glance.

You can re-bucket the same estate by resource family, region or resource type, filter by family or free text, and select any card or tile to inspect it. The detail panel breaks a group down by family and by type; findings call out empty groups, untagged resources and groups sprawling across regions.

## Requirements

- [Azure CLI](https://aka.ms/azure-cli) installed and signed in (`az login`)
- Read access to the subscriptions you want to scan

## Installation

```bash
copilot plugin install azure-resource-group-map@awesome-copilot
```

## Canvas actions

| Action | Purpose |
| --- | --- |
| `scan_resource_groups` | Scan Azure and render the resource map. |
| `get_resource_map` | Return the rendered map and estate statistics for analysis. |
| `find_resources` | Search by name, type, region or tag; supports untagged-only. |
| `set_view` | Change grouping and filters in the canvas. |
| `load_resource_map` | Render a map supplied by the agent instead of scanning Azure. |
| `focus_group` | Select a resource group and show its composition. |

## Source

This plugin is part of [Awesome Copilot](https://github.com/github/awesome-copilot).

## License

MIT
