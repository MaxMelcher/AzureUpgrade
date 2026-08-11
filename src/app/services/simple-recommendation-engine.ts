import { OperatingSystem, RegionalCatalog, VmSku } from '../models/vm.models';
import { migrationGuideUrl as migrationGuideUrlFor } from './retirement-metadata';

/**
 * Simplified, rule-based recommendation engine.
 *
 * The whole decision is expressed as
 *   1. a flat list of hard rules (a candidate is compatible only if every rule passes),
 *   2. one reduction that keeps the best remaining candidate,
 *   3. three outcome rules (EOL migration, cost optimization, keep).
 *
 * It intentionally contains no per-family exceptions or curated overrides.
 */

/** Weights used to score how close a candidate is to the source shape. */
export const CPU_WEIGHT = 10;
export const RAM_WEIGHT = 1;

export type SimpleOutcome =
  'source-not-found' | 'no-compatible-replacement' | 'eol-migration' | 'cost-optimization' | 'keep';

export interface SimpleRecommendation {
  sourceVm: string;
  targetVm: string;
  outcome: SimpleOutcome;
  reason: string;
  sourceHourlyPrice: number | null;
  targetHourlyPrice: number | null;
  savingPercent: number | null;
  candidateCount: number;
  compatibleCandidates: string[];
  migrationGuideUrl: string | null;
}

export interface CompatibilityRule {
  id: string;
  label: string;
  /** True when the candidate may replace the source. */
  passes: (
    source: VmSku,
    candidate: VmSku,
    os: OperatingSystem,
    keepTempDisk: boolean,
  ) => boolean;
}

const hasGpu = (vm: VmSku): boolean => (vm.gpus ?? 0) > 0 || vm.accelerator !== null;

/** A capability of the source must also exist on the target; extra capabilities are fine. */
const preserves = (sourceHas: boolean, candidateHas: boolean): boolean =>
  !sourceHas || candidateHas;

/** Windows requires matching temp-disk presence; Linux may drop it only when explicitly allowed. */
const preservesTempDisk = (
  source: VmSku,
  candidate: VmSku,
  os: OperatingSystem,
  keepTempDisk: boolean,
): boolean =>
  os === 'windows'
    ? source.profile.localTempDisk === candidate.profile.localTempDisk
    : !keepTempDisk || preserves(source.profile.localTempDisk, candidate.profile.localTempDisk);

/** Missing numbers are treated as "unknown and therefore not an exact match". */
const sameNumber = (candidate: number | null, source: number | null): boolean =>
  source !== null && candidate !== null && candidate === source;

const priceOf = (vm: VmSku, os: OperatingSystem): number | null => {
  const price = os === 'linux' ? vm.prices.linuxPaygHourly : vm.prices.windowsPaygHourly;
  return price !== null && price > 0 ? price : null;
};

const isRetired = (vm: VmSku): boolean =>
  vm.lifecycleStatus === 'retired' || vm.lifecycleStatus === 'retirementAnnounced';

const isAvailable = (vm: VmSku, region: string, os: OperatingSystem): boolean =>
  priceOf(vm, os) !== null &&
  !vm.restrictions.some(
    (restriction) =>
      restriction.type.toLowerCase() === 'location' &&
      restriction.reasonCode === 'NotAvailableForSubscription' &&
      restriction.values.some((value) => value.toLowerCase() === region.toLowerCase()),
  );

/** Generation of a candidate, newest first when sorting descending. */
const generationOf = (vm: VmSku): number => (vm.seriesVersion ?? 0) * 100 + (vm.cpuGeneration ?? 0);

/** One deterministic, preferably priced and unconstrained SKU from every Azure family. */
export function representativeSkus(
  catalog: RegionalCatalog,
  os: OperatingSystem = 'linux',
): VmSku[] {
  const families = new Map<string, VmSku[]>();
  for (const sku of catalog.skus) {
    const key = sku.family || sku.name;
    const members = families.get(key) ?? [];
    members.push(sku);
    families.set(key, members);
  }

  const isConstrained = (vm: VmSku): boolean =>
    vm.vcpus !== null && vm.vcpusAvailable !== null && vm.vcpusAvailable < vm.vcpus;

  return [...families.values()]
    .map(
      (members) =>
        members.sort(
          (left, right) =>
            Number(isConstrained(left)) - Number(isConstrained(right)) ||
            Number(priceOf(left, os) === null) - Number(priceOf(right, os) === null) ||
            (left.vcpusAvailable ?? Number.MAX_SAFE_INTEGER) -
              (right.vcpusAvailable ?? Number.MAX_SAFE_INTEGER) ||
            (left.memoryGB ?? Number.MAX_SAFE_INTEGER) -
              (right.memoryGB ?? Number.MAX_SAFE_INTEGER) ||
            left.name.localeCompare(right.name),
        )[0],
    )
    .sort((left, right) => left.family.localeCompare(right.family));
}

/** The rules, in the order they are documented and applied. */
export const COMPATIBILITY_RULES: readonly CompatibilityRule[] = [
  {
    id: 'availability',
    label: 'Offered in the region and priced for this OS',
    passes: (source, candidate, os) => isAvailable(candidate, source.region, os),
  },
  {
    id: 'lifecycle',
    label: 'Target is not retired and has no announced EOL',
    passes: (_source, candidate) => !isRetired(candidate),
  },
  {
    id: 'generation',
    label: 'Target is not an older generation',
    passes: (source, candidate) =>
      candidate.name === source.name || generationOf(candidate) >= generationOf(source),
  },
  {
    id: 'processor',
    label: 'Same CPU vendor and architecture',
    passes: (source, candidate) =>
      source.cpuVendor !== null &&
      source.cpuArchitecture !== null &&
      source.cpuVendor === candidate.cpuVendor &&
      source.cpuArchitecture === candidate.cpuArchitecture,
  },
  {
    id: 'workloadType',
    label: 'Same workload type',
    passes: (source, candidate) =>
      source.workloadFamily !== null &&
      source.workloadFamily === candidate.workloadFamily &&
      source.profile.burstable === candidate.profile.burstable &&
      source.profile.isolated === candidate.profile.isolated,
  },
  {
    id: 'capabilities',
    label: 'Required capabilities preserved',
    passes: (source, candidate, os, keepTempDisk) =>
      preservesTempDisk(source, candidate, os, keepTempDisk) &&
      preserves(hasGpu(source), hasGpu(candidate)) &&
      preserves(source.rdma === true, candidate.rdma === true) &&
      preserves(source.profile.confidential, candidate.profile.confidential) &&
      preserves(source.premiumIO === true, candidate.premiumIO === true),
  },
  {
    id: 'resources',
    label: 'Exact usable vCPU and memory match',
    passes: (source, candidate) =>
      sameNumber(candidate.vcpusAvailable, source.vcpusAvailable) &&
      sameNumber(candidate.memoryGB, source.memoryGB),
  },
];

/** Distance from the source shape. Lower is better. */
export function sizePenalty(source: VmSku, candidate: VmSku): number {
  const vcpuDiff = Math.abs((candidate.vcpusAvailable ?? 0) - (source.vcpusAvailable ?? 0));
  const memoryDiff = Math.abs((candidate.memoryGB ?? 0) - (source.memoryGB ?? 0));
  return vcpuDiff * CPU_WEIGHT + memoryDiff * RAM_WEIGHT;
}

export class SimpleRecommendationEngine {
  private readonly skuLookup: Map<string, VmSku>;

  public constructor(private readonly catalog: RegionalCatalog) {
    this.skuLookup = new Map(catalog.skus.map((sku) => [sku.name.toLowerCase(), sku]));
  }

  public recommend(
    sourceVm: string,
    os: OperatingSystem = 'linux',
    keepTempDisk = true,
  ): SimpleRecommendation {
    const source = this.skuLookup.get(sourceVm.trim().toLowerCase()) ?? null;
    if (!source) {
      return this.result(sourceVm, null, null, 'source-not-found', 'Source VM not found', []);
    }

    const sourcePrice = priceOf(source, os);
    const candidates = this.catalog.skus.filter((candidate) =>
      COMPATIBILITY_RULES.every((rule) => rule.passes(source, candidate, os, keepTempDisk)),
    );
    const alternatives = candidates.filter((candidate) => candidate.name !== source.name);
    if (candidates.length === 0) {
      return this.result(
        source.name,
        source,
        null,
        'no-compatible-replacement',
        'No exact replacement found',
        [],
        os,
      );
    }

    const sourceIsEol = isRetired(source) || source.retirement !== null;
    // An EOL source must be replaced, so it can never win the reduction below.
    const pool = sourceIsEol ? alternatives : candidates;
    if (pool.length === 0) {
      return this.result(
        source.name,
        source,
        null,
        'no-compatible-replacement',
        'No exact replacement found',
        alternatives,
        os,
      );
    }

    const target = pool.reduce((best, candidate) =>
      this.isBetter(source, candidate, best, os) ? candidate : best,
    );
    const targetPrice = priceOf(target, os)!;

    if (sourceIsEol) {
      return this.result(
        source.name,
        source,
        target,
        'eol-migration',
        'EOL migration: cheapest compatible replacement',
        alternatives,
        os,
      );
    }

    if (sourcePrice !== null && targetPrice < sourcePrice) {
      const savingPercent = ((sourcePrice - targetPrice) / sourcePrice) * 100;
      return this.result(
        source.name,
        source,
        target,
        'cost-optimization',
        `Cost optimization: ${savingPercent.toFixed(1)}% cheaper with equivalent capabilities`,
        alternatives,
        os,
      );
    }

    return this.result(
      source.name,
      source,
      source,
      'keep',
      'Keep current VM: supported and no cheaper compatible replacement',
      alternatives,
      os,
    );
  }

  /**
   * Ranking: closest shape first, then cheapest, then newest generation, then name for a stable
   * result.
   */
  private isBetter(source: VmSku, candidate: VmSku, best: VmSku, os: OperatingSystem): boolean {
    const order =
      sizePenalty(source, candidate) - sizePenalty(source, best) ||
      priceOf(candidate, os)! - priceOf(best, os)! ||
      generationOf(best) - generationOf(candidate) ||
      candidate.name.localeCompare(best.name);
    return order < 0;
  }

  private result(
    sourceVm: string,
    source: VmSku | null,
    target: VmSku | null,
    outcome: SimpleOutcome,
    reason: string,
    candidates: readonly VmSku[],
    os: OperatingSystem = 'linux',
  ): SimpleRecommendation {
    const sourceHourlyPrice = source ? priceOf(source, os) : null;
    const targetHourlyPrice = target ? priceOf(target, os) : null;
    const compatibleCandidates = candidates
      .map((candidate) => candidate.name)
      .sort((left, right) => left.localeCompare(right));
    return {
      sourceVm,
      targetVm: target?.name ?? sourceVm,
      outcome,
      reason,
      sourceHourlyPrice,
      targetHourlyPrice,
      savingPercent:
        sourceHourlyPrice !== null && sourceHourlyPrice > 0 && targetHourlyPrice !== null
          ? ((sourceHourlyPrice - targetHourlyPrice) / sourceHourlyPrice) * 100
          : null,
      candidateCount: compatibleCandidates.length,
      compatibleCandidates,
      migrationGuideUrl:
        outcome === 'no-compatible-replacement'
          ? migrationGuideUrlFor(source?.retirement ?? null)
          : null,
    };
  }
}
