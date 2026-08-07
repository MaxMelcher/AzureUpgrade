import { RegionalCatalog, RetirementCatalog, VmRetirement } from '../models/vm.models';

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
