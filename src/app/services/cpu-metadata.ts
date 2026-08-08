import {
  CpuArchitecture,
  CpuCatalog,
  CpuFamilyMetadata,
  RegionalCatalog,
} from '../models/vm.models';

/**
 * Merges curated per-family processor metadata into the regional catalog.
 *
 * SKU-name letters are never parsed: `a` usually means AMD and `p` usually means Arm, but legacy
 * exceptions such as the AMD-based Lsv2 family make the curated family metadata authoritative.
 * Azure-reported architecture still wins over curated architecture when Azure supplies one.
 */
export function applyCpuMetadata(catalog: RegionalCatalog, cpus: CpuCatalog): RegionalCatalog {
  const families = new Map<string, CpuFamilyMetadata>(
    Object.entries(cpus).map(([family, metadata]) => [family.toLowerCase(), metadata]),
  );

  return {
    ...catalog,
    skus: catalog.skus.map((sku) => {
      const metadata = families.get(sku.family.toLowerCase()) ?? null;
      const architecture =
        normalizeArchitecture(sku.architecture) ?? metadata?.architecture ?? null;
      return {
        ...sku,
        hyperVGenerations: normalizeGenerations(sku.hyperVGenerations),
        architecture: sku.architecture ?? metadata?.architecture ?? null,
        cpuVendor: sku.cpuVendor ?? metadata?.vendor ?? null,
        cpuArchitecture: architecture,
        cpuModel: sku.cpuModel ?? metadata?.model ?? null,
        cpuGeneration: sku.cpuGeneration ?? metadata?.generation ?? null,
      };
    }),
  };
}

function normalizeArchitecture(value: string | null): CpuArchitecture | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return null;
}

function normalizeGenerations(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((generation) => generation.trim())
      .filter(Boolean);
  }
  return [];
}
