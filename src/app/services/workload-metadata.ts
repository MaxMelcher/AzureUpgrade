import {
  RegionalCatalog,
  VmProfile,
  WorkloadCatalog,
  WorkloadFamilyMetadata,
} from '../models/vm.models';

const UNKNOWN_PROFILE: VmProfile = {
  burstable: false,
  localTempDisk: false,
  localNvme: false,
  storageBandwidthOptimized: false,
  networkOptimized: false,
  isolated: false,
  confidential: false,
  hpc: false,
};

/**
 * Merges curated workload-family metadata (workload family, series version, capability profile and
 * accelerator) into the regional catalog. Family identifiers come from Azure SKU metadata, so the
 * mapping never depends on parsing the SKU name.
 */
export function applyWorkloadMetadata(
  catalog: RegionalCatalog,
  workloads: WorkloadCatalog,
): RegionalCatalog {
  const families = new Map<string, WorkloadFamilyMetadata>(
    Object.entries(workloads.families).map(([family, metadata]) => [
      family.toLowerCase(),
      metadata,
    ]),
  );

  return {
    ...catalog,
    skus: catalog.skus.map((sku) => {
      const metadata = families.get(sku.family.toLowerCase()) ?? null;
      return {
        ...sku,
        workloadFamily: metadata?.workloadFamily ?? null,
        seriesVersion: metadata?.seriesVersion ?? null,
        profile: metadata
          ? profileOf(metadata, sku.tempDiskMB)
          : { ...UNKNOWN_PROFILE, localTempDisk: (sku.tempDiskMB ?? 0) > 0 },
        accelerator: metadata?.accelerator ?? null,
      };
    }),
  };
}

function profileOf(metadata: WorkloadFamilyMetadata, tempDiskMB: number | null): VmProfile {
  return {
    burstable: metadata.burstable,
    localTempDisk: metadata.localTempDisk === true || (tempDiskMB ?? 0) > 0,
    localNvme: metadata.localNvme,
    storageBandwidthOptimized: metadata.storageBandwidthOptimized,
    networkOptimized: metadata.networkOptimized,
    isolated: metadata.isolated,
    confidential: metadata.confidential,
    hpc: metadata.hpc,
  };
}
