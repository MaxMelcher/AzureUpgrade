import { RegionalCatalog, VmProfile, VmSku } from '../models/vm.models';

/** Test fixtures shared by the service specs. */
export const EMPTY_PROFILE: VmProfile = {
  burstable: false,
  localTempDisk: false,
  localNvme: false,
  storageBandwidthOptimized: false,
  networkOptimized: false,
  isolated: false,
  confidential: false,
  hpc: false,
};

export function prices(linux = 0.2, windows = 0.3) {
  return {
    linuxPaygHourly: linux,
    windowsPaygHourly: windows,
    linuxReservation1Year: null,
    linuxReservation3Year: null,
    windowsReservation1Year: null,
    windowsReservation3Year: null,
  };
}

export function vm(overrides: Partial<VmSku> = {}): VmSku {
  return {
    name: 'Standard_D4as_v4',
    family: 'standardDASv4Family',
    region: 'westeurope',
    tier: 'Standard',
    vcpus: 4,
    vcpusAvailable: 4,
    gpus: 0,
    memoryGB: 16,
    tempDiskMB: 32768,
    maxDataDisks: 8,
    maxNICs: 2,
    premiumIO: true,
    acceleratedNetworking: true,
    ephemeralOSDisk: false,
    rdma: false,
    architecture: 'x64',
    hyperVGenerations: ['V1', 'V2'],
    cpuVendor: 'AMD',
    cpuArchitecture: 'x64',
    cpuModel: 'AMD EPYC 7452 (Rome)',
    cpuGeneration: 2,
    workloadFamily: 'D',
    seriesVersion: 4,
    profile: { ...EMPTY_PROFILE, localTempDisk: true },
    accelerator: null,
    lifecycleStatus: 'current',
    zones: ['1', '2', '3'],
    restrictions: [],
    retirement: null,
    prices: prices(),
    ...overrides,
  };
}

export function region(skus: VmSku[], overrides: Partial<RegionalCatalog> = {}): RegionalCatalog {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    currencyCode: 'EUR',
    region: 'westeurope',
    displayName: 'West Europe',
    skus,
    ...overrides,
  };
}
