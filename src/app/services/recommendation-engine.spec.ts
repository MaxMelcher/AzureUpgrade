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

    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.status).toBe('keep');
    expect(result.recommendationType).toBe('KEEP');
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

    expect(result.recommendation?.vm.name).toBe(source.name);
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

    expect(result.recommendation?.vm.name).toBe(source.name);
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

    expect(result.recommendation?.vm.name).toBe(source.name);
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

    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.rejected.burstableClass).toBe(1);
  });

  it('rejects losing the local temp disk (D2ads_v7 → D2as_v7)', () => {
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

    const result = run(source, [source, withoutTempDisk], 'windows');

    expect(result.status).toBe('keep');
    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.rejected.localStorage).toBe(1);
  });

  it('does not treat Linux resize permission as temp-disk capability preservation', () => {
    const source = vm({
      ...intel,
      name: 'Standard_E32_v3',
      family: 'standardEv3Family',
      workloadFamily: 'E',
      seriesVersion: 3,
      cpuGeneration: 2,
      vcpus: 32,
      vcpusAvailable: 32,
      memoryGB: 256,
      tempDiskMB: 819200,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(1.891),
    });
    const v4 = vm({
      ...intel,
      name: 'Standard_E32_v4',
      family: 'standardEv4Family',
      workloadFamily: 'E',
      seriesVersion: 4,
      cpuGeneration: 3,
      vcpus: 32,
      vcpusAvailable: 32,
      memoryGB: 256,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(1.794),
    });
    const v5 = vm({
      ...intel,
      name: 'Standard_E32_v5',
      family: 'standardEv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 32,
      vcpusAvailable: 32,
      memoryGB: 256,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(1.794),
    });

    const result = run(source, [source, v4, v5]);
    const withoutTempDiskRequired = run(source, [source, v4, v5], 'linux', false, false);
    const windows = run(source, [source, v4, v5], 'windows', false, false);

    expect(result.status).toBe('keep');
    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.rejected.localStorage).toBe(2);
    expect(withoutTempDiskRequired.status).toBe('recommended');
    expect(withoutTempDiskRequired.recommendation?.vm.name).toBe(v5.name);
    expect(withoutTempDiskRequired.recommendation?.lostCapabilities).toContain('local/temp disk');
    expect(
      withoutTempDiskRequired.recommendation?.checks.find((check) => check.id === 'storage')
        ?.passed,
    ).toBe(false);
    expect(withoutTempDiskRequired.recommendation?.notes.join(' ')).toContain(
      'target has no local temporary disk',
    );
    expect(withoutTempDiskRequired.confidence).toBe('Medium');
    expect(windows.rejected.localStorage).toBe(2);
  });

  it('recommends D4ds_v5 instead of dropping the D4ds_v4 temp disk', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4ds_v4',
      family: 'standardDDSv4Family',
      workloadFamily: 'D',
      seriesVersion: 4,
      cpuGeneration: 3,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 16,
      tempDiskMB: 153600,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      lifecycleStatus: 'previousGeneration',
      prices: prices(0.2),
    });
    const withoutTempDisk = vm({
      ...intel,
      name: 'Standard_D4s_v5',
      family: 'standardDSv5Family',
      workloadFamily: 'D',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 16,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.16),
    });
    const successor = vm({
      ...withoutTempDisk,
      name: 'Standard_D4ds_v5',
      family: 'standardDDSv5Family',
      tempDiskMB: 153600,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.19),
    });

    const result = run(source, [source, withoutTempDisk, successor]);

    expect(result.recommendation?.vm.name).toBe(successor.name);
    expect(result.recommendationType).toBe('COST_OPTIMIZATION');
    expect(result.rejected.localStorage).toBe(1);
    expect(result.recommendation?.lostCapabilities).not.toContain('local/temp disk');
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
    expect(result.recommendationType).toBe('COST_OPTIMIZATION');
    expect(result.recommendation?.checks.every((check) => check.passed)).toBe(true);
  });

  it('never recommends an older constrained generation even when it is cheaper', () => {
    const source = vm({
      ...amd,
      name: 'Standard_E96-24as_v5',
      family: 'standardEASv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 3,
      vcpus: 96,
      vcpusAvailable: 24,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });
    const older = vm({
      ...amd,
      name: 'Standard_E96-24as_v4',
      family: 'standardEASv4Family',
      workloadFamily: 'E',
      seriesVersion: 4,
      cpuGeneration: 2,
      vcpus: 96,
      vcpusAvailable: 24,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.05),
    });

    const result = run(source, [source, older]);

    expect(result.status).toBe('keep');
    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.recommendationType).toBe('KEEP');
    expect(result.rejected.olderGeneration).toBe(1);
  });

  it('does not use an older generation as a lifecycle replacement', () => {
    const source = vm({
      ...amd,
      name: 'Standard_E96-24as_v5',
      family: 'standardEASv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 3,
      vcpus: 96,
      vcpusAvailable: 24,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2027-01-01',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.1),
    });
    const older = vm({
      ...amd,
      name: 'Standard_E96-24as_v4',
      family: 'standardEASv4Family',
      workloadFamily: 'E',
      seriesVersion: 4,
      cpuGeneration: 2,
      vcpus: 96,
      vcpusAvailable: 24,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.05),
    });

    const result = run(source, [source, older]);

    expect(result.status).toBe('manual-migration-required');
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

    expect(result.recommendation?.vm.name).toBe(source.name);
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

    expect(result.recommendation?.vm.name).toBe(source.name);
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
    expect(result.recommendationType).toBe('RETIREMENT_MIGRATION');
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
    expect(result.recommendationType).toBe('MANUAL_REVIEW');
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

    expect(result.recommendation?.vm.name).toBe(source.name);
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

    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.rejected.subscriptionRestriction).toBe(1);
  });

  it('keeps a supported source when a newer generation saves less than 5%', () => {
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

    expect(result.status).toBe('keep');
    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.recommendationType).toBe('KEEP');
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

    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.rejected.localStorage).toBe(1);
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

    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.rejected.constrainedShape).toBe(1);
  });

  it('never recommends an isolated profile for a non-isolated source', () => {
    const source = vm({
      ...amd,
      name: 'Standard_E96-24as_v5',
      family: 'standardEASv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 3,
      vcpus: 96,
      vcpusAvailable: 24,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(1),
    });
    const isolated = vm({
      ...amd,
      name: 'Standard_E112ias_v5',
      family: 'standardEIASv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 3,
      vcpus: 112,
      vcpusAvailable: 112,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE, isolated: true },
      prices: prices(0.5),
    });

    for (const os of ['linux', 'windows'] as const) {
      const result = run(source, [source, isolated], os);

      expect(result.status).toBe('keep');
      expect(result.recommendation?.vm.name).toBe(source.name);
      expect(result.recommendationType).toBe('KEEP');
      expect(result.rejected.isolatedProfile).toBe(1);
      expect(result.alternatives).toEqual([]);
      expect(result.manualReview).toEqual([]);
      expect(result.alternativeArchitecture).toEqual([]);
    }
  });

  it('never uses an isolated profile as a lifecycle replacement', () => {
    const source = vm({
      ...amd,
      name: 'Standard_E96-24as_v5',
      family: 'standardEASv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 3,
      vcpus: 96,
      vcpusAvailable: 24,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2027-01-01',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(1),
    });
    const isolated = vm({
      ...amd,
      name: 'Standard_E112ias_v5',
      family: 'standardEIASv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 3,
      vcpus: 112,
      vcpusAvailable: 112,
      memoryGB: 672,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE, isolated: true },
      prices: prices(0.5),
    });

    const result = run(source, [source, isolated]);

    expect(result.status).toBe('manual-migration-required');
    expect(result.recommendation).toBeNull();
    expect(result.rejected.isolatedProfile).toBe(1);
  });

  it('requires migration for an announced EOL even when the successor costs more', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4s_v5',
      family: 'standardDSv5Family',
      seriesVersion: 5,
      cpuGeneration: 4,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2027-01-01',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });
    const successor = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.12),
    });

    const result = run(source, [source, successor]);

    expect(result.mandatoryUpgrade).toBe(true);
    expect(result.recommendation?.vm.name).toBe(successor.name);
    expect(result.recommendationType).toBe('RETIREMENT_MIGRATION');
    expect(result.recommendation?.savingPercent).toBeCloseTo(-20);
  });

  it('uses an exact-shape best-fit migration when strict resize limits require oversizing', () => {
    const source = vm({
      ...intel,
      name: 'Standard_B2s',
      family: 'standardBSFamily',
      workloadFamily: 'B',
      seriesVersion: 1,
      cpuGeneration: 1,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 4,
      maxNICs: 3,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-11-15',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      profile: { ...EMPTY_PROFILE, burstable: true, localTempDisk: true },
      prices: prices(0.04),
    });
    const exactMigration = vm({
      ...intel,
      name: 'Standard_B2ls_v2',
      family: 'standardBsv2Family',
      workloadFamily: 'B',
      seriesVersion: 2,
      cpuGeneration: 4,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 4,
      maxNICs: 2,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE, burstable: true },
      prices: prices(0.04),
    });
    const strictOversize = vm({
      ...exactMigration,
      name: 'Standard_B4ls_v2',
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 8,
      maxNICs: 3,
      prices: prices(0.13),
    });
    const tempPreservingMigration = vm({
      ...intel,
      name: 'Standard_D2lds_v5',
      family: 'standardDLDSv5Family',
      workloadFamily: 'D',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 4,
      maxNICs: 2,
      tempDiskMB: 76800,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.09),
    });

    const candidates = [source, exactMigration, strictOversize, tempPreservingMigration];
    const strict = run(source, candidates);
    const keepTempDisk = run(source, candidates, 'linux', true, true);
    const bestFit = run(source, candidates, 'linux', true, false);

    expect(strict.recommendation).toBeNull();
    expect(strict.status).toBe('manual-migration-required');
    expect(keepTempDisk.recommendation?.vm.name).toBe(tempPreservingMigration.name);
    expect(keepTempDisk.recommendation?.lostCapabilities).not.toContain('local/temp disk');
    expect(bestFit.recommendation?.vm.name).toBe(exactMigration.name);
    expect(bestFit.recommendationType).toBe('RETIREMENT_MIGRATION');
    expect(bestFit.recommendation?.notes.join(' ')).toContain('Best-fit migration');
  });

  it('allows a best-fit mandatory migration to a memory-optimized family', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D15_v2',
      family: 'standardDv2Family',
      workloadFamily: 'D',
      seriesVersion: 2,
      cpuGeneration: 1,
      vcpus: 20,
      vcpusAvailable: 20,
      memoryGB: 140,
      maxDataDisks: 64,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-11-15',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(1.8),
    });
    const target = vm({
      ...intel,
      name: 'Standard_E20_v5',
      family: 'standardEv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 20,
      vcpusAvailable: 20,
      memoryGB: 160,
      maxDataDisks: 32,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(1.1),
    });

    const result = run(source, [source, target], 'linux', true, false);

    expect(result.recommendation?.vm.name).toBe(target.name);
    expect(result.status).toBe('lifecycle-replacement');
  });

  it('uses the reviewed D2s v3 modernization target', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D2s_v3',
      family: 'standardDSv3Family',
      seriesVersion: 3,
      cpuGeneration: 2,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 8,
      tempDiskMB: 16384,
      lifecycleStatus: 'previousGeneration',
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.1),
    });
    const previous = vm({
      ...source,
      name: 'Standard_D2s_v5',
      family: 'standardDSv5Family',
      seriesVersion: 5,
      cpuGeneration: 4,
      lifecycleStatus: 'previousGeneration',
      prices: prices(0.1),
    });
    const current = vm({
      ...source,
      name: 'Standard_D2s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      lifecycleStatus: 'current',
      tempDiskMB: 0,
      hyperVGenerations: ['V2'],
      prices: prices(0.11),
    });

    const result = run(source, [source, previous, current]);

    expect(result.recommendation?.vm.name).toBe(previous.name);
    expect(result.recommendationType).toBe('PERFORMANCE_UPGRADE');
    expect(result.recommendation?.notes.join(' ')).toContain('Reviewed modernization target');
  });

  it('keeps a reviewed previous-generation source when modernization is not warranted', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D2_v4',
      family: 'standardDv4Family',
      seriesVersion: 4,
      cpuGeneration: 3,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 8,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      lifecycleStatus: 'previousGeneration',
      prices: prices(0.1),
    });
    const current = vm({
      ...source,
      name: 'Standard_D2s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuGeneration: 5,
      lifecycleStatus: 'current',
      hyperVGenerations: ['V2'],
      prices: prices(0.11),
    });

    const result = run(source, [source, current]);

    expect(result.recommendation?.vm.name).toBe(source.name);
    expect(result.status).toBe('keep');
    expect(result.recommendationType).toBe('KEEP');
  });

  it('ranks mandatory migrations by shape and rejects unbounded generic expansion', () => {
    const source = vm({
      ...intel,
      name: 'Standard_X2_v1',
      family: 'standardXv1Family',
      workloadFamily: 'X',
      seriesVersion: 1,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 4,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-01-01',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.1),
    });
    const close = vm({
      ...source,
      name: 'Standard_X4_v2',
      family: 'standardXv2Family',
      seriesVersion: 2,
      cpuGeneration: 4,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 8,
      lifecycleStatus: 'current',
      retirement: null,
      prices: prices(0.2),
    });
    const cheapHuge = vm({
      ...close,
      name: 'Standard_X16_v2',
      vcpus: 16,
      vcpusAvailable: 16,
      memoryGB: 32,
      prices: prices(0.05),
    });

    const result = run(source, [source, cheapHuge, close], 'linux', true);
    const onlyHuge = run(source, [source, cheapHuge], 'linux', true);

    expect(result.recommendation?.vm.name).toBe(close.name);
    expect(onlyHuge.status).toBe('manual-migration-required');
  });

  it('preserves Premium SSD during best-fit mandatory migration', () => {
    const source = vm({
      ...intel,
      name: 'Standard_GS1',
      family: 'standardGSFamily',
      workloadFamily: 'G',
      seriesVersion: 1,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 28,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-11-15',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      premiumIO: true,
      prices: prices(0.3),
    });
    const withoutPremium = vm({
      ...source,
      name: 'Standard_E4_v5',
      family: 'standardEv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 32,
      lifecycleStatus: 'current',
      retirement: null,
      premiumIO: false,
      prices: prices(0.2),
    });
    const withPremium = vm({
      ...withoutPremium,
      name: 'Standard_E4s_v5',
      family: 'standardESv5Family',
      premiumIO: true,
      prices: prices(0.21),
    });

    const result = run(source, [source, withoutPremium, withPremium], 'linux', true);

    expect(result.recommendation?.vm.name).toBe(withPremium.name);
    expect(result.recommendation?.lostCapabilities).not.toContain('Premium SSD');
  });

  it('requires manual migration for reviewed M192 isolated v2 sources', () => {
    const source = vm({
      ...intel,
      name: 'Standard_M192is_v2',
      family: 'standardMISMediumMemoryv2Family',
      workloadFamily: 'M',
      seriesVersion: 2,
      vcpus: 192,
      vcpusAvailable: 192,
      memoryGB: 2048,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE, isolated: true },
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2027-03-31',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(15),
    });
    const mv3 = vm({
      ...intel,
      name: 'Standard_M176s_3_v3',
      family: 'standardMSMediumMemoryv3Family',
      workloadFamily: 'M',
      seriesVersion: 3,
      cpuGeneration: 5,
      vcpus: 176,
      vcpusAvailable: 176,
      memoryGB: 2794,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      lifecycleStatus: 'current',
      prices: prices(17),
    });

    const result = run(source, [source, mv3], 'linux', true);

    expect(result.recommendation).toBeNull();
    expect(result.status).toBe('manual-migration-required');
    expect(result.recommendationType).toBe('MANUAL_REVIEW');
  });

  it('uses the reviewed retiring G-series to E-series transition', () => {
    const source = vm({
      ...intel,
      name: 'Standard_G1',
      family: 'standardGFamily',
      workloadFamily: 'G',
      seriesVersion: 1,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 28,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-11-15',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.33),
    });
    const genericOversize = vm({
      ...intel,
      name: 'Standard_D16lds_v5',
      family: 'standardDLDSv5Family',
      workloadFamily: 'D',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 16,
      vcpusAvailable: 16,
      memoryGB: 32,
      lifecycleStatus: 'previousGeneration',
      prices: prices(0.7),
    });
    const documented = vm({
      ...amd,
      name: 'Standard_L8as_v3',
      family: 'standardLASv3Family',
      workloadFamily: 'L',
      seriesVersion: 3,
      cpuGeneration: 4,
      vcpus: 8,
      vcpusAvailable: 8,
      memoryGB: 64,
      profile: { ...EMPTY_PROFILE, localTempDisk: true, localNvme: true },
      lifecycleStatus: 'previousGeneration',
      prices: prices(0.55),
    });
    const reviewed = vm({
      ...intel,
      name: 'Standard_E4_v5',
      family: 'standardEv5Family',
      workloadFamily: 'E',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 32,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      lifecycleStatus: 'current',
      prices: prices(0.26),
    });

    const result = run(source, [source, genericOversize, documented, reviewed], 'linux', true);

    expect(result.recommendation?.vm.name).toBe(reviewed.name);
    expect(result.recommendation?.notes.join(' ')).toContain('Reviewed migration target');
  });

  it('uses the reviewed L4s v4 retirement target', () => {
    const source = vm({
      ...intel,
      name: 'Standard_L4s',
      family: 'standardLSFamily',
      workloadFamily: 'L',
      seriesVersion: 1,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 32,
      profile: { ...EMPTY_PROFILE, localTempDisk: true, localNvme: true },
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-05-01',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.27),
    });
    const target = vm({
      ...intel,
      name: 'Standard_L4s_v4',
      family: 'StandardLsv4Family',
      workloadFamily: 'L',
      seriesVersion: 4,
      cpuGeneration: 5,
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 32,
      profile: { ...EMPTY_PROFILE, localTempDisk: true, localNvme: true },
      lifecycleStatus: 'current',
      prices: prices(0.31),
    });

    const result = run(source, [source, target], 'linux', true);

    expect(result.recommendation?.vm.name).toBe(target.name);
    expect(result.status).toBe('lifecycle-replacement');
  });

  it('uses the documented NCv3 to NCadsH100 v5 transition', () => {
    const source = vm({
      ...intel,
      name: 'Standard_NC6s_v3',
      family: 'standardNCSv3Family',
      workloadFamily: 'NC',
      seriesVersion: 3,
      vcpus: 6,
      vcpusAvailable: 6,
      memoryGB: 112,
      gpus: 1,
      accelerator: { vendor: 'NVIDIA', model: 'Tesla V100', workload: 'gpu-compute' },
      lifecycleStatus: 'retired',
      retirement: {
        eolDate: '2025-09-30',
        description: 'Retired',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(2.7),
    });
    const h100 = vm({
      ...amd,
      name: 'Standard_NC40ads_H100_v5',
      family: 'StandardNCadsH100v5Family',
      workloadFamily: 'NC',
      seriesVersion: 5,
      cpuGeneration: 5,
      vcpus: 40,
      vcpusAvailable: 40,
      memoryGB: 320,
      gpus: 1,
      accelerator: { vendor: 'NVIDIA', model: 'H100', workload: 'gpu-compute' },
      lifecycleStatus: 'current',
      prices: prices(6.6),
    });

    const result = run(source, [source, h100], 'linux', true);

    expect(result.recommendation?.vm.name).toBe(h100.name);
    expect(result.recommendation?.checks.find((check) => check.id === 'accelerator')?.passed).toBe(
      false,
    );
  });

  it('keeps the A1 v2 temp disk during mandatory migration unless explicitly disabled', () => {
    const source = vm({
      ...intel,
      name: 'Standard_A1_v2',
      family: 'standardAv2Family',
      workloadFamily: 'A',
      seriesVersion: 2,
      cpuGeneration: 1,
      vcpus: 1,
      vcpusAvailable: 1,
      memoryGB: 2,
      tempDiskMB: 10240,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-08-31',
        description: 'Retirement announced',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.03),
    });
    const withoutTempDisk = vm({
      ...intel,
      name: 'Standard_D2ls_v5',
      family: 'standardDLSv5Family',
      workloadFamily: 'D',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 4,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.07),
    });
    const withTempDisk = vm({
      ...withoutTempDisk,
      name: 'Standard_D2lds_v5',
      family: 'standardDLDSv5Family',
      tempDiskMB: 76800,
      profile: { ...EMPTY_PROFILE, localTempDisk: true },
      prices: prices(0.08),
    });

    const keep = run(source, [source, withoutTempDisk, withTempDisk], 'linux', true, true);
    const remove = run(source, [source, withoutTempDisk, withTempDisk], 'linux', true, false);

    expect(keep.recommendation?.vm.name).toBe(withTempDisk.name);
    expect(keep.recommendation?.lostCapabilities).not.toContain('local/temp disk');
    expect(remove.recommendation?.vm.name).toBe(withoutTempDisk.name);
    expect(remove.recommendation?.lostCapabilities).toContain('local/temp disk');
  });

  it('modernizes a previous-generation exact shape when the source price is unavailable', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D16s_v3',
      family: 'standardDSv3Family',
      seriesVersion: 3,
      cpuGeneration: 2,
      vcpus: 16,
      vcpusAvailable: 16,
      memoryGB: 64,
      lifecycleStatus: 'previousGeneration',
      prices: { ...prices(), linuxPaygHourly: null },
    });
    const target = vm({
      ...intel,
      name: 'Standard_D16s_v5',
      family: 'standardDSv5Family',
      seriesVersion: 5,
      cpuGeneration: 4,
      vcpus: 16,
      vcpusAvailable: 16,
      memoryGB: 64,
      prices: prices(0.67),
    });

    const result = run(source, [source, target]);

    expect(result.recommendation?.vm.name).toBe(target.name);
    expect(result.recommendationType).toBe('PERFORMANCE_UPGRADE');
    expect(result.recommendation?.savingPercent).toBeNull();
  });

  it('uses generation only to break a capability and price tie', () => {
    const source = vm({
      ...intel,
      name: 'Standard_D4s_v4',
      seriesVersion: 4,
      cpuGeneration: 3,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.2),
    });
    const older = vm({
      ...intel,
      name: 'Standard_D4s_v3',
      seriesVersion: 3,
      cpuGeneration: 2,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });
    const newer = vm({
      ...intel,
      name: 'Standard_D4s_v6',
      seriesVersion: 6,
      cpuGeneration: 5,
      tempDiskMB: 0,
      profile: { ...EMPTY_PROFILE },
      prices: prices(0.1),
    });

    const result = run(source, [source, older, newer]);

    expect(result.recommendation?.vm.name).toBe(newer.name);
  });

  it('produces one deterministic approval result per family with recommendation state', () => {
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
    const largerSameFamily = vm({
      ...source,
      name: 'Standard_D8s_v5',
      vcpus: 8,
      vcpusAvailable: 8,
      memoryGB: 32,
      prices: prices(0.2),
    });

    const engine = new RecommendationEngine(region([source, largerSameFamily, newer]));
    const rows = engine.createQualityMatrix(['linux']);
    const approvals = engine.createRepresentativeRecommendations('linux');
    const row = rows.find((entry) => entry.sourceSku === 'Standard_D4s_v5');

    expect(rows).toHaveLength(2);
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map((result) => result.source?.family)).size).toBe(2);
    expect(approvals.some((result) => result.source?.name === largerSameFamily.name)).toBe(false);
    expect(row?.recommendation).toBe('Standard_D4s_v6');
    expect(row?.recommendationState).toBe('recommended');
    expect(row?.sourceLifecycleStatus).toBe('current');
  });
});

function run(
  source: VmSku,
  skus: VmSku[],
  os: 'linux' | 'windows' = 'linux',
  includeMigrationRecommendations = false,
  keepTempDisk = true,
): RecommendationResult {
  return new RecommendationEngine(region(skus)).findRecommendations(source.name, 'westeurope', os, {
    includeMigrationRecommendations,
    keepTempDisk,
  });
}
