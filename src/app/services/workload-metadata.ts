import { RegionalCatalog, WorkloadCatalog, WorkloadClass } from '../models/vm.models';

export function applyWorkloadMetadata(
  catalog: RegionalCatalog,
  workloads: WorkloadCatalog,
): RegionalCatalog {
  const families = new Map<string, WorkloadClass>(
    Object.entries(workloads.families).map(([family, workloadClass]) => [
      family.toLowerCase(),
      workloadClass,
    ]),
  );

  return {
    ...catalog,
    skus: catalog.skus.map((sku) => ({
      ...sku,
      workloadClass: families.get(sku.family.toLowerCase()) ?? null,
    })),
  };
}
