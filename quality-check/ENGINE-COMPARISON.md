# Engine comparison: rule-based vs. current matcher

`npm run qa:compare-engines` runs both engines over the same UK South catalog and writes
`engine-comparison-uksouth-linux.csv` (one row per Azure family representative, Linux PAYG, GBP).

- `src/app/services/recommendation-engine.ts` – the current matcher (~1,270 lines): hard filters,
  a separate migration filter, a modernization path, curated per-family exceptions, reviewed
  overrides, UI badges, confidence and explanations.
- `src/app/services/simple-recommendation-engine.ts` – the simplified engine (~250 lines): six
  declarative rules in `COMPATIBILITY_RULES`, one `reduce` that keeps the best candidate, and three
  outcome rules (EOL migration, cost optimization, keep). No per-family exceptions and no curated
  overrides.

## Result (UK South, Linux, 143 family representatives)

| Metric              | Value       |
| ------------------- | ----------- |
| Same target VM      | 97 (67.8 %) |
| Different target VM | 46 (32.2 %) |

| Current type → simple outcome                    | Rows |
| ------------------------------------------------ | ---- |
| KEEP → keep                                      | 77   |
| KEEP → cost-optimization                         | 27   |
| MANUAL_REVIEW → no-compatible-replacement        | 10   |
| PERFORMANCE_UPGRADE → keep                       | 10   |
| RETIREMENT_MIGRATION → eol-migration             | 6    |
| KEEP → no-compatible-replacement                 | 4    |
| PERFORMANCE_UPGRADE → cost-optimization          | 3    |
| COST_OPTIMIZATION → keep                         | 3    |
| RETIREMENT_MIGRATION → no-compatible-replacement | 2    |
| COST_OPTIMIZATION → cost-optimization            | 1    |

## Why the two engines disagree

1. **No minimum saving.** The simple engine migrates for any price difference, the current engine
   requires at least 5 % (`MATERIAL_SAVING_PERCENT`). This explains most `KEEP → cost-optimization`
   rows, for example `Standard_E2s_v6 → Standard_E2s_v5` at 4.5 %.
2. **No "never go backwards" rule.** The pseudocode ranks by shape, then price, and only uses the
   generation as a tie-break, so a cheaper older series wins:
   `Standard_D2ads_v7 → Standard_D2as_v4`, `Standard_E2ds_v6 → Standard_E2s_v3`. The current engine
   rejects older generations outright. Adding one rule to `COMPATIBILITY_RULES` would close this gap.
3. **Coarse workload type.** The simple engine treats the whole `D`/`E` family as one workload type,
   so it crosses sub-series (`d`, `l`, `n`, `b` variants) as long as the capability rules pass. The
   current engine also compares family lineage, NVMe, storage bandwidth, network optimization,
   data-disk and NIC limits, accelerated networking, Hyper-V generation and constrained-core shapes.
4. **No modernization path.** `PERFORMANCE_UPGRADE` does not exist in the simple engine: if a newer
   generation is not cheaper it simply keeps the source (10 rows).
5. **Strict processor rule.** Vendor equality is literal, so Ampere → Cobalt Arm64 moves such as
   `Standard_D2ps_v5 → Standard_D2ps_v6` are not proposed.
6. **No documented retirement paths.** Retiring families whose successor changes vendor, workload
   family or capabilities (`Standard_G1`, `Standard_GS1`, the `M192` sizes, `NCv3`) end as
   `no-compatible-replacement`, and `Standard_L4s` migrates to the cheapest compatible `L`-size
   (`Standard_L8s_v3`) instead of the reviewed `Standard_L4s_v4`.

## Reading of the comparison

The simplified engine reproduces the current outcome for roughly two thirds of all families with
about a fifth of the code, and every decision is traceable to one named rule. The remaining third is
where the current engine's extra knowledge matters: minimum savings, generation direction, detailed
capability parity and Microsoft-documented retirement paths. The simple engine is therefore a
readable baseline and a good target shape for a refactoring, but it is not yet a drop-in replacement
without at least the generation rule, a minimum-saving threshold and the documented retirement
transitions.
