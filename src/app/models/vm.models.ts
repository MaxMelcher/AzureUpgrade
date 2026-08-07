export type OperatingSystem = 'linux' | 'windows';
export type CpuPolicy = 'same-vendor' | 'prefer-same-vendor' | 'any-compatible';
export type Confidence = 'High' | 'Medium' | 'Low';

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

export interface VmSku {
  name: string;
  family: string;
  region: string;
  tier: string;
  vcpus: number | null;
  vcpusAvailable: number | null;
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
  cpuVendor: string | null;
  cpuGeneration: number | null;
  zones: string[];
  restrictions: VmRestriction[];
  prices: VmPrices;
}

export interface RegionInfo {
  name: string;
  displayName: string;
  skuCount: number;
}

export interface RegionalCatalog {
  schemaVersion: number;
  generatedAt: string;
  currencyCode: string;
  region: string;
  displayName: string;
  skus: VmSku[];
}

export interface RejectedCandidateStatistics {
  totalCandidates: number;
  sourceSku: number;
  price: number;
  usableVcpus: number;
  memory: number;
  dataDisks: number;
  tempDisk: number;
  premiumIO: number;
  acceleratedNetworking: number;
  rdma: number;
  architecture: number;
  cpuVendor: number;
  olderGeneration: number;
}

export type RecommendationStatus =
  | 'recommended'
  | 'sku-not-found'
  | 'source-price-missing'
  | 'incomplete-capabilities'
  | 'no-compatible-replacement';

export interface CandidateRecommendation {
  vm: VmSku;
  score: number;
  hourlyPrice: number;
  monthlySaving: number | null;
  savingPercent: number | null;
}

export interface RecommendationResult {
  inputSku: string;
  status: RecommendationStatus;
  region: string;
  os: OperatingSystem;
  source: VmSku | null;
  recommendation: CandidateRecommendation | null;
  alternatives: CandidateRecommendation[];
  rejected: RejectedCandidateStatistics;
  explanation: string;
  confidence: Confidence;
}

export interface QualityMatrixRow {
  region: string;
  sourceSku: string;
  os: OperatingSystem;
  cpuPolicy: CpuPolicy;
  status: RecommendationStatus;
  recommendation: string;
  sourceHourly: number | null;
  recommendedHourly: number | null;
  monthlySaving: number | null;
  savingPercent: number | null;
  confidence: Confidence;
  explanation: string;
}
