export type OperatingSystem = 'linux' | 'windows';
export type CurrencyCode = 'USD' | 'EUR' | 'GBP';
export type CpuVendor = 'Intel' | 'AMD' | 'Microsoft' | 'Ampere' | 'NVIDIA' | 'other';
export type CpuArchitecture = 'x64' | 'arm64';
export type AcceleratorWorkload =
  'gpu-compute' | 'gpu-training' | 'gpu-visualization' | 'gpu-gaming' | 'fpga';
export type LifecycleStatus = 'current' | 'previousGeneration' | 'retirementAnnounced' | 'retired';

export interface VmPrices {
  linuxPaygHourly: number | null;
  windowsPaygHourly: number | null;
  linuxReservation1Year: number | null;
  linuxReservation3Year: number | null;
  windowsReservation1Year: number | null;
  windowsReservation3Year: number | null;
}

export interface VmRestriction {
  type: string;
  reasonCode: string | null;
  values: string[];
}

export interface VmRetirement {
  eolDate: string;
  description: string;
  sourceUrl: string;
  migrationGuideUrl?: string;
  regionEolDates?: Record<string, string>;
}

export interface RetirementCatalog {
  families: Record<string, VmRetirement>;
  skus: Record<string, VmRetirement>;
}

export interface CpuFamilyMetadata {
  vendor: CpuVendor;
  architecture: CpuArchitecture;
  generation: number;
  model: string;
}

export type CpuCatalog = Record<string, CpuFamilyMetadata>;

export interface AcceleratorMetadata {
  vendor: string;
  model: string;
  workload: AcceleratorWorkload;
}

export interface VmProfile {
  burstable: boolean;
  localTempDisk: boolean;
  localNvme: boolean;
  storageBandwidthOptimized: boolean;
  networkOptimized: boolean;
  isolated: boolean;
  confidential: boolean;
  hpc: boolean;
}

export interface WorkloadFamilyMetadata extends VmProfile {
  workloadFamily: string;
  seriesVersion: number;
  accelerator: AcceleratorMetadata | null;
}

export interface WorkloadCatalog {
  families: Record<string, WorkloadFamilyMetadata>;
}

export interface VmSku {
  name: string;
  family: string;
  region: string;
  tier: string;
  vcpus: number | null;
  vcpusAvailable: number | null;
  gpus: number | null;
  memoryGB: number | null;
  tempDiskMB: number | null;
  maxDataDisks: number | null;
  maxNICs: number | null;
  premiumIO: boolean | null;
  acceleratedNetworking: boolean | null;
  ephemeralOSDisk: boolean | null;
  rdma: boolean | null;
  architecture: string | null;
  hyperVGenerations: string[];
  cpuVendor: CpuVendor | null;
  cpuArchitecture: CpuArchitecture | null;
  cpuModel: string | null;
  cpuGeneration: number | null;
  workloadFamily: string | null;
  seriesVersion: number | null;
  profile: VmProfile;
  accelerator: AcceleratorMetadata | null;
  zones: string[];
  restrictions: VmRestriction[];
  retirement: VmRetirement | null;
  lifecycleStatus: LifecycleStatus;
  prices: VmPrices;
}

export interface RegionInfo {
  name: string;
  displayName: string;
  skuCount: number;
  generatedAt: string;
}

export interface RegionalCatalog {
  schemaVersion: number;
  generatedAt: string;
  currencyCode: CurrencyCode;
  region: string;
  displayName: string;
  skus: VmSku[];
}
