import { RegionalCatalog, VmSku, WorkloadCatalog } from '../models/vm.models';
import { applyWorkloadMetadata } from './workload-metadata';

describe('applyWorkloadMetadata', () => {
  it('matches exact Azure family identifiers case-insensitively', () => {
    const metadata: WorkloadCatalog = {
      families: { standarddcsv3family: 'confidential-compute' },
    };
    const catalog = applyWorkloadMetadata(region(vm()), metadata);
    expect(catalog.skus[0].workloadClass).toBe('confidential-compute');
  });
});

function region(sku: VmSku): RegionalCatalog {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    currencyCode: 'GBP',
    region: 'uksouth',
    displayName: 'UK South',
    skus: [sku],
  };
}

function vm(): VmSku {
  return {
    name: 'Standard_DC2s_v3',
    family: 'standardDCSv3Family',
    region: 'uksouth',
    tier: 'Standard',
    vcpus: 2,
    vcpusAvailable: 2,
    gpus: 0,
    memoryGB: 8,
    tempDiskMB: 0,
    maxDataDisks: 4,
    maxNICs: 2,
    premiumIO: true,
    acceleratedNetworking: true,
    ephemeralOSDisk: true,
    rdma: false,
    architecture: 'x64',
    hyperVGenerations: ['V2'],
    cpuVendor: 'Intel',
    cpuGeneration: 3,
    zones: [],
    restrictions: [],
    retirement: null,
    workloadClass: null,
    prices: {
      linuxPaygHourly: 0.1,
      windowsPaygHourly: 0.2,
      linuxReservation1Year: null,
      linuxReservation3Year: null,
      windowsReservation1Year: null,
      windowsReservation3Year: null,
    },
  };
}
