# Azure VM Upgrade Advisor

A production-ready, backend-free Angular application that recommends modern Azure VM replacements by comparing authoritative regional SKU capabilities and public Azure retail prices.

The matcher never infers hardware from SKU-name letters. Temporary storage, usable vCPU, architecture, Premium IO, accelerated networking, RDMA, and disk limits all come from `az vm list-skus`.

## Features

- Regional, case-insensitive lookup for pasted VM lists
- Linux and Windows PAYG recommendations in USD, EUR, or GBP
- Hard compatibility filters for usable vCPU, GPU count, memory, architecture, Premium IO, accelerated networking, and RDMA
- Constrained-vCPU candidates only for constrained sources, OS-specific local temp-disk resize rules, and surfaced data-disk-limit risks
- Correct constrained-vCPU handling
- Same-vendor, prefer-same-vendor, and any-compatible CPU policies
- Ranked recommendation plus three alternatives, explanation, confidence, and rejection statistics
- Hourly, monthly, yearly, and monthly-saving estimates
- Savings-based result groups and mandatory upgrades for retired VM families with official EOL dates
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
7. Merges curated CPU metadata from `src/assets/data/cpu-families.json`.
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

`npm run qa:recommendations` writes `quality-check/recommendations-uksouth-linux-family.csv`. It contains one representative VM per UK South family for Linux and all three CPU policies, using the exact same matcher as the application.

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

`cpu-families.json` is curated CPU metadata. `retirements.json` contains family identifiers and exact
SKU exceptions verified against Azure SKU metadata and official
[Azure VM size lifecycle documentation](https://learn.microsoft.com/azure/virtual-machines/sizes/lifecycle/retired-sizes-list).
Azure-reported architecture takes precedence over curated architecture. Unknown CPU families stay
unknown and reduce recommendation confidence.

## Cost estimates

Monthly cost is hourly price x 730; yearly cost is hourly price x 8,760. USD, EUR, and GBP values
come directly from Azure's Retail Prices API. Prices are public retail estimates and do not include
negotiated discounts, subscription offers, Azure Hybrid Benefit, or deployment-specific licensing.
