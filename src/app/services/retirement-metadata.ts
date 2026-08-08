import {
  LifecycleStatus,
  RegionalCatalog,
  RetirementCatalog,
  VmRetirement,
  VmSku,
} from '../models/vm.models';

export function applyRetirementMetadata(
  catalog: RegionalCatalog,
  retirements: RetirementCatalog,
): RegionalCatalog {
  const families = caseInsensitiveMap(retirements.families);
  const skus = caseInsensitiveMap(retirements.skus);

  return {
    ...catalog,
    skus: catalog.skus.map((sku) => ({
      ...sku,
      retirement: resolveRetirement(
        skus.get(sku.name.toLowerCase()) ?? families.get(sku.family.toLowerCase()) ?? null,
        catalog.region,
      ),
    })),
  };
}

/**
 * Classifies every SKU as current, previousGeneration, retirementAnnounced or retired. A SKU is a
 * previous generation when the same workload family on the same processor platform offers a newer
 * series version in the same region.
 */
export function applyLifecycleStatus(catalog: RegionalCatalog, now = new Date()): RegionalCatalog {
  const newestSeries = new Map<string, number>();
  for (const sku of catalog.skus) {
    if (sku.workloadFamily === null || sku.seriesVersion === null) continue;
    const key = generationKey(sku);
    newestSeries.set(key, Math.max(newestSeries.get(key) ?? 0, sku.seriesVersion));
  }

  return {
    ...catalog,
    skus: catalog.skus.map((sku) => ({
      ...sku,
      lifecycleStatus: lifecycleStatusFor(sku, newestSeries, now),
    })),
  };
}

export function isRetired(retirement: VmRetirement | null, now = new Date()): boolean {
  if (!retirement) return false;
  const endOfLife = Date.parse(`${retirement.eolDate}T23:59:59Z`);
  return Number.isFinite(endOfLife) && endOfLife < now.getTime();
}

export function migrationGuideUrl(retirement: VmRetirement | null): string | null {
  if (!retirement) return null;
  return retirement.migrationGuideUrl ?? retirement.sourceUrl ?? null;
}

function lifecycleStatusFor(
  sku: VmSku,
  newestSeries: ReadonlyMap<string, number>,
  now: Date,
): LifecycleStatus {
  if (isRetired(sku.retirement, now)) return 'retired';
  if (sku.retirement) return 'retirementAnnounced';
  if (sku.workloadFamily === null || sku.seriesVersion === null) return 'current';
  return (newestSeries.get(generationKey(sku)) ?? sku.seriesVersion) > sku.seriesVersion
    ? 'previousGeneration'
    : 'current';
}

function generationKey(sku: VmSku): string {
  return `${sku.workloadFamily}|${sku.cpuVendor ?? 'unknown'}|${sku.cpuArchitecture ?? 'unknown'}`;
}

function resolveRetirement(retirement: VmRetirement | null, region: string): VmRetirement | null {
  if (!retirement) return null;
  const regionalDate = retirement.regionEolDates?.[region.toLowerCase()];
  return regionalDate ? { ...retirement, eolDate: regionalDate } : retirement;
}

function caseInsensitiveMap(
  values: Record<string, VmRetirement>,
): ReadonlyMap<string, VmRetirement> {
  return new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
}
