# Recommendation quality report

Audit date: 7 August 2026  
Catalog: UK South, Linux, GBP, refreshed 7 August 2026

## Scope and method

The quality matrix covers one deterministic, unconstrained, Linux-priced representative from
each Azure VM family in UK South. CPU-policy rows are collapsed when they produce the same
outcome. The resulting matrix contains 148 outcomes across 143 families.

Each recommendation was checked for:

- usable vCPU, memory, GPU count, architecture, Premium IO, accelerated networking, RDMA,
  constrained-vCPU shape, burstable class, and Linux temp-disk compatibility;
- retirement status and whether an announced EOL is mandatory under the selected policy;
- CPU-vendor changes where curated vendor metadata is available;
- confidential-compute, local-NVMe, GPU-compute, GPU-training, and GPU-visualization purpose;
- location-level `NotAvailableForSubscription` restrictions in the source catalog;
- regional Linux PAYG price and monthly savings using 730 hours.

The complete result set is in
[`recommendations-uksouth-linux-audited-2026-08-07.csv`](recommendations-uksouth-linux-audited-2026-08-07.csv).

## Baseline audit

The initial 147-row audit flagged 55 outcomes. Twenty-one were expected Linux temp-disk notices.
The remaining 34 exposed systemic risks rather than isolated bad rows:

- candidates could cross workload purposes, including confidential, storage-optimized, and
  distinct GPU workloads;
- subscription/location restrictions were present in normalized data but not enforced;
- constrained and burstable families, GPU count, CPU-vendor comparison, and material-upgrade
  thresholds needed stronger controls;
- linear data-disk penalties could outweigh a meaningful price benefit;
- scheduled EOL recommendations could appear more urgent than their dates justified;
- zero-difference outcomes could appear in the cost-increase group.

## Corrections applied

- Constrained targets are only eligible for constrained sources.
- Non-burstable sources cannot move to burstable B-series targets.
- GPU count is a hard minimum.
- CPU generation is compared only within the same known vendor.
- Modern, non-EOL sources stay on the current size unless a candidate has a material saving or a
  newer same-vendor CPU generation.
- Announced EOL remains optional unless the user enables the EOL-required toggle; already-retired
  sizes remain mandatory.
- Curated exact-family workload classes now prevent confidential, local-NVMe, GPU-compute,
  GPU-training, and GPU-visualization crossover.
- Location-level `NotAvailableForSubscription` candidates are rejected. This is a subscription
  restriction, not a claim that the SKU does not exist in the Azure region.
- Data-disk-limit reductions remain disclosed, but their score penalty is capped so it cannot
  dominate all price and generation benefits.
- Monthly cost groups use the actual GBP price difference, including a separate neutral group.

## Revised results

| Status | Outcomes |
|---|---:|
| Recommended | 84 |
| No upgrade needed | 51 |
| No compatible replacement | 7 |
| Source price missing | 6 |
| **Total** | **148** |

Post-fix checks:

- 0 recommendations cross a curated workload class.
- 0 recommendations target a location-restricted SKU.
- 0 price-increase recommendations lack an EOL date.
- 7 price increases remain, all for families with announced or passed EOL dates.
- `Standard_DS3_v2` recommends `Standard_D4ds_v5`.
- `Standard_B1ls` recommends `Standard_B2ts_v2`.
- `Standard_B2ats_v2` stays on the current AMD size.

The seven `no-compatible-replacement` outcomes are conservative. They cover HBv3 and specialized
ND/NV GPU representatives where no priced candidate meets all hard requirements without crossing
the curated workload purpose.

## Remaining limitations

- CPU vendor and generation metadata is curated and still incomplete. Unknown metadata is not
  inferred from SKU names.
- Workload classes are curated by exact Azure family ID. New families need explicit classification
  before they receive the same protection.
- Azure restrictions reflect the subscription used to generate the catalog. Quotas, policies,
  capacity, and availability can differ for another subscription.
- The family matrix intentionally omits constrained representatives. Their behavior is covered by
  automated regression tests but should also be spot-checked for a specific constrained workload.
- Ephemeral OS disk, maximum NIC count, and availability zones are displayed catalog attributes,
  not hard migration requirements.
- A lower data-disk limit is a disclosed risk, not a blocker, because actual attached-disk usage is
  unknown.

The advisor is a screening tool, not a deployment guarantee. Validate quota, capacity, disk and
network requirements, architecture, application licensing, and performance with Azure before
resizing production workloads.
