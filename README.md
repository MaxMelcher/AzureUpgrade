# Azure VM Upgrade Advisor

A production-ready, backend-free Angular application that recommends modern Azure VM replacements by comparing authoritative regional SKU capabilities and public Azure retail prices.

Recommendations are compatibility-first and cost-second: price is only compared after every hard
compatibility rule has passed. The matcher never infers hardware from SKU-name letters. Temporary
storage, usable vCPU, architecture, Premium IO, accelerated networking, RDMA, and disk limits come
from `az vm list-skus`, and CPU vendor/architecture/model plus the workload profile come from
curated per-family metadata that overrides name parsing (for example `Lsv2` is AMD even though its
name has no `a`).

## Features

- Regional, case-insensitive lookup for pasted VM lists
- Linux and Windows PAYG recommendations in USD, EUR, or GBP
- Ordered candidate selection: hardware compatibility, workload profile, regional availability, lifecycle, performance equivalence, then price
- CPU vendor and architecture are hard constraints; Intel↔AMD and x64↔Arm64 changes are only ever offered as a separate "Alternative architecture" option
- Workload family is preserved; cross-family targets are surfaced for manual review only
- B-series is never proposed for a non-burstable source without utilization telemetry
- Never downsizes vCPU or memory, never recommends an older generation, and never proposes a retiring size
- Local/temp disk, local NVMe, storage-bandwidth, network and accelerator capabilities must be preserved; a cheaper size without the temp disk is only shown as a conditional saving
- GPU sources stay in the accelerator domain and are never replaced by CPU-only sizes
- Result states: Recommended, Equivalent modernization, Conditional saving, Lifecycle replacement, Alternative architecture, Manual review, and No safe cheaper replacement
- Source/destination comparison with explicit ✓/✕ compatibility badges per recommendation
- Hourly, monthly, yearly, and monthly-saving estimates
- Lifecycle metadata (current, previous generation, retirement announced, retired) with official EOL dates and migration guidance
- Excel-friendly CSV, clipboard export, and an exhaustive quality-check matrix
- Responsive light/dark UI with no browser calls to Azure

## Requirements

- Node.js 24+
- PowerShell 7+
- Azure CLI
- An authenticated Azure CLI session

## Generate the catalog

```powershell
az login

pwsh ./tools/Generate-VmCatalog.ps1 `
    -Regions uksouth
```

Generate every physical Azure region:

```powershell
pwsh ./tools/Generate-VmCatalog.ps1 -AllRegions
```

By default, the generator creates USD, EUR, and GBP catalogs. Use
`-CurrencyCode GBP` or `-CurrencyCode USD,EUR` to generate only selected currencies.

The generator:

1. Gets regional VM capabilities with `az vm list-skus --all`.
2. Follows every Azure Retail Prices API page.
3. Excludes Spot, Low Priority, and Dev/Test meters from PAYG.
4. Uses active, primary, hourly Consumption meters matched by `armSkuName`.
5. Logs ambiguous active meters and selects deterministically by newest effective date, then lowest price, then meter ID.
6. Normalizes reservation full-term prices to effective hourly prices using 8,760 hours/year.
7. Merges curated CPU metadata (vendor, architecture, model, platform generation) from `src/assets/data/cpu-families.json`.
8. Atomically writes compact UTF-8 JSON without a BOM.

Missing capabilities and prices remain `null`; they are never guessed. Azure-reported SKU restrictions
remain in the catalog; candidates marked `NotAvailableForSubscription` in the selected location are
excluded without claiming that the SKU is absent from the region for every subscription.

## Develop and validate

```powershell
npm install
npm test
npm run build
npm run qa:recommendations
npm start
```

Open `http://localhost:4200`.

`npm run qa:recommendations` writes `quality-check/recommendations-uksouth-linux-family.csv`. It contains one representative VM per UK South family for Linux, including the resulting recommendation state and source lifecycle status, using the exact same engine as the application.

### Approval matrix

Open `http://localhost:4200/?view=approval` to review one deterministic representative VM from every
Azure resource SKU family. Select the region, currency, operating system, mandatory-migration mode,
and Linux temp-disk policy, then generate the matrix. Each row includes the selected recommendation,
prices, lifecycle outcome, failed compatibility checks, capability losses, and full explanation.

Mark each row **Correct** or **Incorrect**. Incorrect rows require a **Correct recommendation** from
the regional catalog, or an explicit **No automatic recommendation** selection. Decisions and
corrections are stored locally in the browser and are keyed by the complete recommendation identity
and matrix configuration, so a changed recommendation is automatically unreviewed. Use the status
filters to focus on unreviewed or rejected rows.

**Download approval JSON** exports a stable, sorted snapshot suitable for checking into source
control and comparing in approval/snapshot tests. It intentionally excludes the export time and
catalog refresh timestamp; only the matrix configuration, recommendation results, compatibility
details, verdicts, and expected corrections participate in diffs. Schema version 2 distinguishes an
expected SKU from an explicit expectation that no automatic recommendation should be produced.

## Static hosting

The production output is `dist/azure-vm-upgrade-advisor/browser`. Deploy that folder to Azure Static Web Apps or any static file host. `public/staticwebapp.config.json` supplies the static MIME types and fallback behavior.

Pushes to `main` automatically test, build, and deploy through
`.github/workflows/deploy-static-web-app.yml`. Create the GitHub Actions secret
`AZURE_STATIC_WEB_APPS_API_TOKEN` with the Static Web App deployment token before enabling the
workflow.

## Data layout

```text
src/assets/data/
  regions.json
  cpu-families.json
  retirements.json
  workload-families.json
  regions/
    usd/
      <region>.json
    eur/
      <region>.json
    gbp/
      <region>.json
```

`cpu-families.json` is curated CPU metadata (`vendor`, `architecture`, `model`, `generation`) keyed by
the Azure resource SKU family identifier. `workload-families.json` is the curated workload profile
(`workloadFamily`, `seriesVersion`, burstable, local temp disk, local NVMe, storage-bandwidth,
network optimized, isolated, confidential, HPC and accelerator details). Both are authoritative and
override anything that could be guessed from a SKU name; the local temp disk flag also compensates
for Azure reporting `MaxResourceVolumeMB = 0` on newer sizes. `retirements.json` contains family
identifiers and exact
SKU exceptions verified against Azure SKU metadata and official
[Azure VM size lifecycle documentation](https://learn.microsoft.com/azure/virtual-machines/sizes/lifecycle/retired-sizes-list).
Azure-reported architecture takes precedence over curated architecture. Unknown CPU families stay
unknown and reduce recommendation confidence.

## Cost estimates

Monthly cost is hourly price x 730; yearly cost is hourly price x 8,760. USD, EUR, and GBP values
come directly from Azure's Retail Prices API. Prices are public retail estimates and do not include
negotiated discounts, subscription offers, Azure Hybrid Benefit, or deployment-specific licensing.
