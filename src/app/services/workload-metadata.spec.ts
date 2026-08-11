import { describe, expect, it } from 'vitest';

import { WorkloadCatalog } from '../models/vm.models';
import { region, vm } from './vm.fixtures';
import { applyWorkloadMetadata } from './workload-metadata';

const metadata: WorkloadCatalog = {
  families: {
    standarddcsv3family: {
      workloadFamily: 'DC',
      seriesVersion: 3,
      burstable: false,
      localTempDisk: false,
      localNvme: false,
      storageBandwidthOptimized: false,
      networkOptimized: false,
      isolated: false,
      confidential: true,
      hpc: false,
      accelerator: null,
    },
    standardddsv6family: {
      workloadFamily: 'D',
      seriesVersion: 6,
      burstable: false,
      localTempDisk: true,
      localNvme: false,
      storageBandwidthOptimized: false,
      networkOptimized: false,
      isolated: false,
      confidential: false,
      hpc: false,
      accelerator: null,
    },
  },
};

describe('applyWorkloadMetadata', () => {
  it('matches exact Azure family identifiers case-insensitively', () => {
    const sku = vm({ name: 'Standard_DC2s_v3', family: 'standardDCSv3Family' });
    const catalog = applyWorkloadMetadata(region([sku]), metadata);

    expect(catalog.skus[0].workloadFamily).toBe('DC');
    expect(catalog.skus[0].seriesVersion).toBe(3);
    expect(catalog.skus[0].profile.confidential).toBe(true);
  });

  it('keeps the curated local temp disk flag when Azure reports no resource volume', () => {
    const sku = vm({ name: 'Standard_D2ds_v6', family: 'StandardDdsv6Family', tempDiskMB: 0 });
    const catalog = applyWorkloadMetadata(region([sku]), metadata);

    expect(catalog.skus[0].profile.localTempDisk).toBe(true);
  });

  it('derives a local temp disk from the reported resource volume for unknown families', () => {
    const sku = vm({ name: 'Standard_XX', family: 'unknownFamily', tempDiskMB: 1024 });
    const catalog = applyWorkloadMetadata(region([sku]), metadata);

    expect(catalog.skus[0].workloadFamily).toBeNull();
    expect(catalog.skus[0].profile.localTempDisk).toBe(true);
  });
});
