import { RegionalCatalog, VmSku } from '../models/vm.models';
import { RecommendationEngine } from './recommendation-engine';

describe('RecommendationEngine', () => {
  it('allows Linux to resize from a local temp disk to no local temp disk', () => {
    const source = vm({
      name: 'Standard_D4as_v4',
      family: 'standardDASv4Family',
      tempDiskMB: 32768,
      cpuVendor: 'AMD',
      cpuGeneration: 2,
    });
    const noTempDisk = vm({
      name: 'Standard_D4as_v5',
      family: 'standardDASv5Family',
      tempDiskMB: 0,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.05),
    });
    const compatible = vm({
      name: 'Standard_D4ads_v5',
      family: 'standardDADSv5Family',
      tempDiskMB: 76800,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.14),
    });

    const result = engine(source, noTempDisk, compatible).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );

    expect(result.recommendation?.vm.name).toBe('Standard_D4as_v5');
    expect(result.rejected.tempDisk).toBe(0);
  });

  it('requires Windows source and target to have matching local temp disk presence', () => {
    const source = vm({ tempDiskMB: 32768 });
    const noTempDisk = vm({
      name: 'Standard_D4as_v5',
      tempDiskMB: 0,
      prices: prices(0.05),
    });
    const withTempDisk = vm({
      name: 'Standard_D4ads_v5',
      tempDiskMB: 76800,
      prices: prices(0.14, 0.2),
    });
    const result = engine(source, noTempDisk, withTempDisk).findRecommendations(
      source.name,
      'westeurope',
      'windows',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4ads_v5');
    expect(result.rejected.tempDisk).toBe(1);
  });

  it('prevents Windows from resizing from no local temp disk to a size with one', () => {
    const source = vm({ tempDiskMB: 0 });
    const withTempDisk = vm({
      name: 'Standard_D4ads_v5',
      tempDiskMB: 76800,
      prices: prices(0.05, 0.1),
    });
    const noTempDisk = vm({
      name: 'Standard_D4as_v5',
      tempDiskMB: 0,
      prices: prices(0.14, 0.2),
    });
    const result = engine(source, withTempDisk, noTempDisk).findRecommendations(
      source.name,
      'westeurope',
      'windows',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4as_v5');
    expect(result.rejected.tempDisk).toBe(1);
  });

  it('allows Linux to resize from no local temp disk to a size with one', () => {
    const source = vm({ tempDiskMB: 0 });
    const withTempDisk = vm({
      name: 'Standard_D4ads_v5',
      tempDiskMB: 76800,
      prices: prices(0.05),
    });
    const result = engine(source, withTempDisk).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4ads_v5');
    expect(result.rejected.tempDisk).toBe(0);
    expect(result.explanation).toContain('with local temporary storage');
  });

  it('preserves usable vCPU for a constrained-vCPU source without favoring physical CPU count', () => {
    const source = vm({
      name: 'Standard_E16-4as_v4',
      vcpus: 16,
      vcpusAvailable: 4,
      memoryGB: 128,
      cpuVendor: 'AMD',
      cpuGeneration: 2,
      prices: prices(0.9),
    });
    const constrained = vm({
      name: 'Standard_E16-4as_v5',
      vcpus: 16,
      vcpusAvailable: 4,
      memoryGB: 128,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.7),
    });
    const fullCpu = vm({
      name: 'Standard_E16as_v5',
      vcpus: 16,
      vcpusAvailable: 16,
      memoryGB: 128,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.69),
    });

    const result = engine(source, fullCpu, constrained).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );

    expect(result.recommendation?.vm.name).toBe('Standard_E16-4as_v5');
  });

  it('never recommends a constrained shape for an unconstrained source', () => {
    const source = vm({
      name: 'Standard_DS3_v2',
      memoryGB: 14,
      maxDataDisks: 16,
      cpuGeneration: 1,
      prices: prices(0.3),
    });
    const constrained = vm({
      name: 'Standard_E8-4ds_v4',
      vcpus: 8,
      vcpusAvailable: 4,
      memoryGB: 64,
      maxDataDisks: 16,
      cpuGeneration: 3,
      prices: prices(0.1),
    });
    const regular = vm({
      name: 'Standard_D4ds_v5',
      memoryGB: 16,
      maxDataDisks: 8,
      cpuGeneration: 4,
      prices: prices(0.2),
    });
    const result = engine(source, constrained, regular).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4ds_v5');
    expect(result.rejected.constrainedShape).toBe(1);
    expect(result.explanation).toContain('reduced data disk limit');
  });

  it('finds source SKUs case-insensitively', () => {
    const source = vm({ name: 'Standard_DS3_v2' });
    const replacement = vm({ name: 'Standard_D4s_v5', cpuGeneration: 4, prices: prices(0.15) });
    const result = engine(source, replacement).findRecommendations(
      'standard_ds3_V2',
      'westeurope',
      'linux',
    );
    expect(result.source?.name).toBe('Standard_DS3_v2');
  });

  it('enforces same-vendor CPU policy as a hard filter', () => {
    const source = vm({ cpuVendor: 'AMD', cpuGeneration: 2 });
    const intel = vm({
      name: 'Standard_D4s_v5',
      cpuVendor: 'Intel',
      cpuGeneration: 4,
      prices: prices(0.1),
    });
    const amd = vm({
      name: 'Standard_D4as_v5',
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.2),
    });
    const result = engine(source, intel, amd).findRecommendations(
      source.name,
      'westeurope',
      'linux',
      'same-vendor',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4as_v5');
    expect(result.rejected.cpuVendor).toBe(1);
  });

  it('returns a useful not-found state without guessing from the SKU name', () => {
    const result = engine(vm({})).findRecommendations('Standard_XYZ', 'westeurope', 'linux');
    expect(result.status).toBe('sku-not-found');
    expect(result.recommendation).toBeNull();
  });

  it('refuses to match when important source capability metadata is incomplete', () => {
    const source = vm({ tempDiskMB: null });
    const result = engine(source, vm({ name: 'Standard_D4s_v5' })).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.status).toBe('incomplete-capabilities');
    expect(result.confidence).toBe('Low');
  });

  it('requires a usable price for the selected operating system', () => {
    const source = vm({});
    const linuxOnly = vm({
      name: 'Standard_D4s_v5',
      prices: {
        ...prices(0.15),
        windowsPaygHourly: null,
      },
    });

    const result = engine(source, linuxOnly).findRecommendations(
      source.name,
      'westeurope',
      'windows',
    );
    expect(result.status).toBe('no-compatible-replacement');
    expect(result.rejected.price).toBe(1);
  });

  it('still recommends compatible hardware when the retired source has no current price', () => {
    const source = vm({
      prices: {
        ...prices(),
        linuxPaygHourly: null,
      },
    });
    const replacement = vm({
      name: 'Standard_D4ads_v5',
      tempDiskMB: 76800,
      cpuGeneration: 3,
      prices: prices(0.15),
    });
    const result = engine(source, replacement).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.status).toBe('source-price-missing');
    expect(result.recommendation?.vm.name).toBe('Standard_D4ads_v5');
    expect(result.recommendation?.monthlySaving).toBeNull();
  });

  it('creates every source and CPU-policy quality-check combination for Linux', () => {
    const matrix = engine(vm({}), vm({ name: 'Standard_D4s_v5' })).createQualityMatrix();
    expect(matrix).toHaveLength(1);
    expect(new Set(matrix.map((row) => row.os))).toEqual(new Set(['linux']));
    expect(matrix[0].cpuPolicy).toBe('same-vendor | prefer-same-vendor | any-compatible');
  });

  it('uses one unconstrained Linux-priced representative per family in the quality matrix', () => {
    const constrained = vm({
      name: 'Standard_E8-4ds_v5',
      vcpus: 8,
      vcpusAvailable: 4,
      prices: prices(0.1),
    });
    const regular = vm({ name: 'Standard_E4ds_v5', prices: prices(0.2) });
    const otherFamily = vm({
      name: 'Standard_F4s_v2',
      family: 'standardFSv2Family',
      prices: prices(0.15),
    });
    const matrix = engine(constrained, regular, otherFamily).createQualityMatrix();
    expect(matrix).toHaveLength(2);
    expect(new Set(matrix.map((row) => row.sourceSku))).toEqual(
      new Set(['Standard_E4ds_v5', 'Standard_F4s_v2']),
    );
  });

  it('makes a retired source mandatory and never recommends a retiring candidate', () => {
    const source = vm({
      retirement: {
        eolDate: '2020-01-01',
        description: 'Retired test family',
        sourceUrl: 'https://learn.microsoft.com/',
      },
    });

    const retiredCandidate = vm({
      name: 'Standard_D4ads_v5',
      cpuGeneration: 3,
      retirement: {
        eolDate: '2030-01-01',
        description: 'Scheduled retirement',
        sourceUrl: 'https://learn.microsoft.com/',
      },
      prices: prices(0.1),
    });
    const supportedCandidate = vm({
      name: 'Standard_D4ads_v6',
      cpuGeneration: 4,
      prices: prices(0.15),
    });
    const result = engine(source, retiredCandidate, supportedCandidate).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.mandatoryUpgrade).toBe(true);
    expect(result.recommendation?.vm.name).toBe('Standard_D4ads_v6');
    expect(result.rejected.retirement).toBe(1);
    expect(result.explanation).toContain('upgrading is required');
  });

  it('only makes a future announced EOL mandatory when the user enables the policy', () => {
    const source = vm({
      retirement: {
        eolDate: '2099-01-01',
        description: 'Scheduled test retirement',
        sourceUrl: 'https://learn.microsoft.com/',
      },
    });
    const replacement = vm({
      name: 'Standard_D4ads_v6',
      cpuGeneration: 4,
      prices: prices(0.15),
    });
    const advisor = engine(source, replacement);
    const optional = advisor.findRecommendations(source.name, 'westeurope', 'linux');
    const required = advisor.findRecommendations(
      source.name,
      'westeurope',
      'linux',
      'prefer-same-vendor',
      true,
    );
    expect(optional.mandatoryUpgrade).toBe(false);
    expect(optional.explanation).toContain('migration can be planned');
    expect(required.mandatoryUpgrade).toBe(true);
    expect(required.explanation).toContain('selected policy makes upgrading required');
  });

  it('prefers a much cheaper compatible B-series size over exact CPU matching', () => {
    const source = vm({
      name: 'Standard_B1ls',
      family: 'standardBSFamily',
      vcpus: 1,
      vcpusAvailable: 1,
      memoryGB: 0.5,
      tempDiskMB: 4096,
      cpuVendor: 'Intel',
      cpuGeneration: 2,
      prices: prices(0.0045),
      retirement: {
        eolDate: '2028-11-15',
        description: 'B-series retirement',
        sourceUrl: 'https://learn.microsoft.com/',
      },
    });
    const expensiveExact = vm({
      name: 'Standard_F1als_v7',
      vcpus: 1,
      vcpusAvailable: 1,
      memoryGB: 2,
      tempDiskMB: 0,
      cpuVendor: null,
      cpuGeneration: null,
      prices: prices(0.0533),
    });
    const cheaperCompatible = vm({
      name: 'Standard_B2ts_v2',
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 1,
      tempDiskMB: 0,
      cpuVendor: 'Intel',
      cpuGeneration: 5,
      prices: prices(0.0089),
    });
    const result = engine(source, expensiveExact, cheaperCompatible).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_B2ts_v2');
  });

  it('keeps a modern AMD source when the only exact candidate is costlier Intel', () => {
    const source = vm({
      name: 'Standard_B2ats_v2',
      family: 'standardBasv2Family',
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 1,
      tempDiskMB: 0,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.008),
    });
    const intel = vm({
      name: 'Standard_B2ts_v2',
      family: 'standardBsv2Family',
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 1,
      tempDiskMB: 0,
      cpuVendor: 'Intel',
      cpuGeneration: 5,
      prices: prices(0.0089),
    });
    const result = engine(source, intel).findRecommendations(source.name, 'westeurope', 'linux');
    expect(result.status).toBe('no-upgrade-needed');
    expect(result.recommendation).toBeNull();
  });

  it('never treats a burstable target as an upgrade for a non-burstable source', () => {
    const source = vm({
      name: 'Standard_E2ds_v5',
      family: 'standardEDSv5Family',
      cpuVendor: 'Intel',
      cpuGeneration: 4,
      prices: prices(0.128),
    });
    const burstable = vm({
      name: 'Standard_B4s_v2',
      family: 'standardBsv2Family',
      cpuVendor: 'Intel',
      cpuGeneration: 5,
      prices: prices(0.1432),
    });
    const result = engine(source, burstable).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.status).toBe('no-compatible-replacement');
    expect(result.rejected.burstableClass).toBe(1);
  });

  it('recognizes Arm Bps v2 as a burstable family', () => {
    const source = vm({ prices: prices(0.3) });
    const burstableArm = vm({
      name: 'Standard_B2pls_v2',
      family: 'standardBpsv2Family',
      architecture: 'x64',
      prices: prices(0.05),
    });
    const regular = vm({
      name: 'Standard_D2als_v6',
      prices: prices(0.2),
    });
    const result = engine(source, burstableArm, regular).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D2als_v6');
    expect(result.rejected.burstableClass).toBe(1);
  });

  it('preserves confidential-compute workload affinity', () => {
    const source = vm({
      name: 'Standard_DC2ads_v6',
      workloadClass: 'confidential-compute',
      prices: prices(0.3),
    });
    const generalPurpose = vm({
      name: 'Standard_B2as_v2',
      prices: prices(0.1),
    });
    const confidential = vm({
      name: 'Standard_DC2as_v6',
      workloadClass: 'confidential-compute',
      prices: prices(0.2),
    });
    const result = engine(source, generalPurpose, confidential).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_DC2as_v6');
    expect(result.rejected.workloadAffinity).toBe(1);
  });

  it('rejects candidates unavailable to the catalog subscription in the selected region', () => {
    const source = vm({ prices: prices(0.3) });
    const restricted = vm({
      name: 'Standard_NV6ads_A10_v5',
      prices: prices(0.1),
      restrictions: [
        {
          type: 'Location',
          reasonCode: 'NotAvailableForSubscription',
          values: ['westeurope'],
        },
      ],
    });
    const available = vm({
      name: 'Standard_D4ds_v5',
      prices: prices(0.2),
    });
    const result = engine(source, restricted, available).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4ds_v5');
    expect(result.rejected.subscriptionRestriction).toBe(1);
  });

  it('does not let a moderate data-disk-limit reduction outweigh a meaningful saving', () => {
    const source = vm({
      maxDataDisks: 16,
      prices: prices(0.2),
    });
    const cheaper = vm({
      name: 'Standard_D4s_v6',
      maxDataDisks: 8,
      prices: prices(0.17),
    });
    const expensive = vm({
      name: 'Standard_D4ds_v6',
      maxDataDisks: 16,
      prices: prices(0.24),
    });
    const result = engine(source, cheaper, expensive).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_D4s_v6');
  });

  it('never replaces a GPU source with a non-GPU candidate', () => {
    const source = vm({ name: 'Standard_NC6s_v3', gpus: 1 });
    const cpuOnly = vm({
      name: 'Standard_DC8s_v3',
      vcpus: 8,
      vcpusAvailable: 8,
      gpus: 0,
      prices: prices(0.1),
    });
    const gpuCandidate = vm({
      name: 'Standard_NC8ads_A10_v5',
      vcpus: 8,
      vcpusAvailable: 8,
      gpus: 1,
      cpuGeneration: 3,
      prices: prices(0.2),
    });
    const result = engine(source, cpuOnly, gpuCandidate).findRecommendations(
      source.name,
      'westeurope',
      'linux',
    );
    expect(result.recommendation?.vm.name).toBe('Standard_NC8ads_A10_v5');
    expect(result.rejected.gpus).toBe(1);
  });
});

function engine(...skus: VmSku[]): RecommendationEngine {
  const catalog: RegionalCatalog = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    currencyCode: 'EUR',
    region: 'westeurope',
    displayName: 'West Europe',
    skus,
  };
  return new RecommendationEngine(catalog);
}

function prices(linux = 0.2, windows = 0.3) {
  return {
    linuxPaygHourly: linux,
    windowsPaygHourly: windows,
    linuxReservation1Year: null,
    linuxReservation3Year: null,
    windowsReservation1Year: null,
    windowsReservation3Year: null,
  };
}

function vm(overrides: Partial<VmSku>): VmSku {
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
    cpuGeneration: 2,
    zones: ['1', '2', '3'],
    restrictions: [],
    retirement: null,
    workloadClass: null,
    prices: prices(),
    ...overrides,
  };
}
