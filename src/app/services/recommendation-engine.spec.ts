import { RecommendationResult, VmSku } from '../models/vm.models';
import { RecommendationEngine } from './recommendation-engine';
import { EMPTY_PROFILE, prices, region, vm } from './vm.fixtures';

const intel = {
  cpuVendor: 'Intel',
  cpuArchitecture: 'x64',
  cpuModel: 'Intel Xeon Platinum 8480C (Sapphire Rapids)',
  architecture: 'x64',
} as const;
const amd = {
  cpuVendor: 'AMD',
  cpuArchitecture: 'x64',
  cpuModel: 'AMD EPYC 9005 (Turin)',
  architecture: 'x64',
} as const;
const arm = {
  cpuVendor: 'Microsoft',
  cpuArchitecture: 'arm64',
  cpuModel: 'Azure Cobalt 100',
  architecture: 'Arm64',
} as const;

describe('RecommendationEngine compatibility rules', () => {
  it('rejects Intel → AMD as a primary recommendation (D2s_v6 → D2as_v7)', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D2s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      profile: { ...EMPTY_PROFILE },
      tempDiskMB: 0,
      prices: prices(0.1),
    });
    const amdCandidate = vm({
      ...amd,
      name: 'Standard_D2as_v7',
      family: 'StandardDasv7Family',
      seriesVersion: 7,
      cpuGeneration: 5,
      profile: { ...EMPTY_PROFILE },
      tempDiskMB: 0,
      prices: prices(0.05),
    });

    const result = run(source, [source, amdCandidate]);

    expect(result.recommendation).toBeNull();
    expect(result.status).toBe('no-safe-cheaper-replacement');
    expect(result.alternativeArchitecture.map((entry) => entry.vm.name)).toEqual([
      'Standard_D2as_v7',
    ]);
  });

  it('rejects Intel → AMD for memory optimized sources (E2s_v5 → E2as_v6)', () => {
    const source = vm({
      ...intel,
      name: 'Standard_E2s_v5',
      family: 'standardESv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 4,
      profile: { ...EMPTY_PROFILE },
      tempDiskMB: 0,
      prices: prices(0.1),
    });
    const amdCandidate = vm({
      ...amd,
      name: 'Standard_E2as_v6',
      family: 'standardEav6Family',
      workloadFamily: 'E',
      seriesVersion: 6,
      cpuGeneration: 4,
      profile: { ...EMPTY_PROFILE },
      tempDiskMB: 0,
      prices: prices(0.06),
    });

    const result = run(source, [source, amdCandidate]);

    expect(result.recommendation).toBeNull();
  });

  it('rejects AMD sources being modernized onto Intel and vice versa (D2d_v4 → D2a_v4)', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D2d_v4',
      family: 'standardDDv4Family',
      seriesVersion: 4,
      cpuGeneration: 3,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.1),
    });
    const amdCandidate = vm({
      ...amd,
      name: 'Standard_D2a_v4',
      family: 'standardDAv4Family',
      seriesVersion: 4,
      cpuGeneration: 2,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.04),
    });

    const result = run(source, [source, amdCandidate]);

    expect(result.recommendation).toBeNull();
  });

  it('never replaces a GPU source with a CPU-only size (NG8ads_V620_v1 → D8als_v6)', () => {
    const source = vm({
      ...amd,
      name: 'Standard_NG8ads_V620_v1',
      family: 'StandardNGADSV620v1Family',
      workloadFamily: 'NG',
      seriesVersion: 1,
      gpus: 1,
      accelerator: { vendor: 'AMD', model: 'Radeon PRO V620', workload: 'gpu-gaming' },
      prices: prices(1),
    });
    const cpuOnly = vm({
      ...amd,
      name: 'Standard_D8als_v6',
      family: 'standardDalv6Family',
      workloadFamily: 'D',
      seriesVersion: 6,
      cpuGeneration: 4,
      profile: { ...EMPTY_PROFILE },
      tempDiskMB: 0,
      prices: prices(0.2),
    });

    const result = run(source, [source, cpuOnly]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.accelerator).toBe(1);
  });

  it('never recommends a burstable size for a non-burstable source (D2ps_v6 → B2ps_v2)', () => {
    const source = vm({
      ...arm,
      name: 'Standard_D2ps_v6',
      family: 'StandardDpsv6Family',
      seriesVersion: 6,
      cpuGeneration: 2,
      profile: { ...EMPTY_PROFILE },
      tempDiskMB: 0,
      prices: prices(0.1),
    });
    const burstable = vm({
      ...arm,
      name: 'Standard_B2ps_v2',
      family: 'standardBpsv2Family',
      workloadFamily: 'B',
      seriesVersion: 2,
      cpuGeneration: 1,
      profile: { ...EMPTY_PROFILE, burstable: true },
      tempDiskMB: 0,
      prices: prices(0.03),
    });

    const result = run(source, [source, burstable]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.burstableClass).toBe(1);
  });

  it('marks losing the local temp disk as a conditional saving (D2ads_v7 → D2as_v7)', () => {
    const source = vm({
      ...amd,
      name: 'Standard_D2ads_v7',
      family: 'StandardDadsv7Family',
      seriesVersion: 7,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.1),
    });
    const withoutTempDisk = vm({
      ...amd,
      name: 'Standard_D2as_v7',
      family: 'StandardDasv7Family',
      seriesVersion: 7,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.08),
    });

    const result = run(source, [source, withoutTempDisk]);

    expect(result.status).toBe('conditional-saving');
    expect(result.recommendation?.vm.name).toBe('Standard_D2as_v7');
    expect(result.recommendation?.notes).toContain('Cheaper if local/temp disk is not required');
    expect(result.recommendation?.checks.find((check) => check.id === 'storage')?.passed).toBe(
      false,
    );
  });

  it('recommends a same-architecture newer generation (E2ps_v5 → E2ps_v6)', () => {
    const source = vm({
      name: 'Standard_E2ps_v5',
      family: 'standardEPSv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuVendor: 'Ampere',
      cpuArchitecture: 'arm64',
      cpuModel: 'Ampere Altra',
      architecture: 'Arm64',
      cpuGeneration: 1,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });
    const newer = vm({
      ...arm,
      name: 'Standard_E2ps_v6',
      family: 'StandardEpsv6Family',
      workloadFamily: 'E',
      seriesVersion: 6,
      cpuGeneration: 2,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.08),
    });

    const result = run(source, [source, newer]);

    expect(result.status).toBe('recommended');
    expect(result.recommendation?.vm.name).toBe('Standard_E2ps_v6');
    expect(result.recommendation?.checks.every((check) => check.passed)).toBe(true);
  });

  it('never recommends an older generation even when it is cheaper (D2ads_v5 → D2ds_v4)', () => {
    const source = vm({
      ...amd,
      name: 'Standard_D2ads_v5',
      family: 'standardDADSv5Family',
      seriesVersion: 5,
      cpuGeneration: 3,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.1),
    });
    const older = vm({
      ...amd,
      name: 'Standard_D2ds_v4',
      family: 'standardDDSv4Family',
      seriesVersion: 4,
      cpuGeneration: 2,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.05),
    });

    const result = run(source, [source, older]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.olderGeneration).toBe(1);
  });

  it('keeps the workload family and flags cross-family candidates for manual review', () => {
    const source = vm({
      ...intel,
      name: 'Standard_F4s_v2',
      family: 'standardFSv2Family',
      workloadFamily: 'F',
      seriesVersion: 2,
      cpuGeneration: 2,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.2),
    });
    const otherFamily = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      workloadFamily: 'D',
      seriesVersion: 6,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });

    const result = run(source, [source, otherFamily]);

    expect(result.recommendation).toBeNull();
    expect(result.manualReview.map((entry) => entry.vm.name)).toEqual(['Standard_D4s_v6']);
  });

  it('never downsizes vCPU or memory without utilization telemetry', () => {
    const source = vm({ ...intel, seriesVersion: 5, cpuGeneration: 4, prices: prices(0.2) });
    const smaller = vm({
      ...intel,
      name: 'Standard_D2s_v6',
      family: 'StandardDsv6Family',
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 8,
      seriesVersion: 6,
      cpuGeneration: 5,
      prices: prices(0.05),
    });

    const result = run(source, [source, smaller]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.usableVcpus + result.rejected.memory).toBeGreaterThan(0);
  });

  it('reports a lifecycle replacement when a retired source has no cheaper successor', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4_v2',
      family: 'standardDv2Family',
      seriesVersion: 2,
      cpuGeneration: 1,
      lifecycleStatus: 'retired',
      retirement: {
        eolDate: '2024-08-31',
        description: 'Retired size',
        sourceUrl: 'https://learn.microsoft.com/',
        migrationGuideUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.1),
    });
    const successor = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.12),
    });

    const result = run(source, [source, successor]);

    expect(result.mandatoryUpgrade).toBe(true);
    expect(result.status).toBe('lifecycle-replacement');
    expect(result.recommendation?.vm.name).toBe('Standard_D4s_v6');
  });

  it('requires manual migration when a retired source has no compatible successor', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4_v2',
      family: 'standardDv2Family',
      seriesVersion: 2,
      cpuGeneration: 1,
      lifecycleStatus: 'retired',
      retirement: {
        eolDate: '2024-08-31',
        description: 'Retired size',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.1),
    });
    const amdOnly = vm({
      ...amd,
      name: 'Standard_D4as_v7',
      family: 'StandardDasv7Family',
      seriesVersion: 7,
      cpuGeneration: 5,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.05),
    });

    const result = run(source, [source, amdOnly]);

    expect(result.status).toBe('manual-migration-required');
    expect(result.recommendation).toBeNull();
  });

  it('never proposes a candidate that is itself retiring', () => {
    const source = vm({ ...intel, seriesVersion: 5, cpuGeneration: 4, prices: prices(0.2) });
    const retiring = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2027-01-01',
        description: 'Retiring size',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.1),
    });

    const result = run(source, [source, retiring]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.retirement).toBe(1);
  });

  it('excludes sizes restricted for the subscription in the selected region', () => {
    const source = vm({ ...intel, seriesVersion: 5, cpuGeneration: 4, prices: prices(0.2) });
    const restricted = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      restrictions: [
        { type: 'Location', values: ['westeurope'], reasonCode: 'NotAvailableForSubscription' },
      ],
      prices: prices(0.1),
    });

    const result = run(source, [source, restricted]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.subscriptionRestriction).toBe(1);
  });

  it('classifies a compatible newer generation within ±5% as equivalent modernization', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4s_v5',
      family: 'standardDSv5Family',
      seriesVersion: 5,
      cpuGeneration: 4,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });
    const newer = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.099),
    });

    const result = run(source, [source, newer]);

    expect(result.status).toBe('equivalent-modernization');
    expect(result.recommendation?.vm.name).toBe('Standard_D4s_v6');
  });

  it('preserves local NVMe storage for storage optimized sources', () => {
    const source = vm({
      ...amd,
      name: 'Standard_L8s_v2',
      family: 'standardLSv2Family',
      workloadFamily: 'L',
      seriesVersion: 2,
      cpuVendor: 'AMD',
      cpuModel: 'AMD EPYC 7551 (Naples)',
      cpuGeneration: 1,
      vcpus: 8,
      vcpusAvailable: 8,
      memoryGB: 64,
      profile: { ...EMPTY_PROFILE, localNvme: true, localTempDisk: true },
      prices: prices(0.5),
    });
    const withoutNvme = vm({
      ...amd,
      name: 'Standard_E8as_v6',
      family: 'standardEav6Family',
      workloadFamily: 'E',
      seriesVersion: 6,
      cpuGeneration: 4,
      vcpus: 8,
      vcpusAvailable: 8,
      memoryGB: 64,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.3),
    });

    const result = run(source, [source, withoutNvme]);

    expect(result.recommendation).toBeNull();
    expect(result.manualReview[0]?.vm.name).toBe('Standard_E8as_v6');
  });

  it('keeps constrained-vCPU behaviour', () => {
    const source = vm({
      ...intel,
      name: 'Standard_E8-4s_v5',
      family: 'standardESv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 8,
      vcpusAvailable: 4,
      memoryGB: 64,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.4),
    });
    const unconstrained = vm({
      ...intel,
      name: 'Standard_E4s_v6',
      family: 'StandardEsv6Family',
      workloadFamily: 'E',
      seriesVersion: 6,
      cpuGeneration: 5,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 64,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.2),
    });

    const result = run(source, [source, unconstrained]);

    expect(result.recommendation).toBeNull();
    expect(result.rejected.constrainedShape).toBe(1);
  });

  it('produces a quality matrix row per size with the recommendation state', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4s_v5',
      family: 'standardDSv5Family',
      seriesVersion: 5,
      cpuGeneration: 4,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });
    const newer = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.07),
    });

    const rows = new RecommendationEngine(region([source, newer])).createQualityMatrix(['linux']);
    const row = rows.find((entry) => entry.sourceSku === 'Standard_D4s_v5');

    expect(row?.recommendation).toBe('Standard_D4s_v6');
    expect(row?.recommendationState).toBe('recommended');
    expect(row?.sourceLifecycleStatus).toBe('current');
  });
});

function run(source: VmSku, skus: VmSku[]): RecommendationResult {
  return new RecommendationEngine(region(skus)).findRecommendations(
    source.name,
    'westeurope',
    'linux',
  );
}
