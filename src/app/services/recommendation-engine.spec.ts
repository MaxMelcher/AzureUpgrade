import { RegionalCatalog, VmSku } from '../models/vm.models';
import { RecommendationEngine } from './recommendation-engine';

describe('RecommendationEngine', () => {
  it('rejects a candidate without enough temporary storage for Standard_D4as_v4', () => {
    const source = vm({
      name: 'Standard_D4as_v4',
      family: 'standardDASv4Family',
      tempDiskMB: 32768,
      cpuVendor: 'AMD',
      cpuGeneration: 2
    });
    const noTempDisk = vm({
      name: 'Standard_D4as_v5',
      family: 'standardDASv5Family',
      tempDiskMB: 0,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.12)
    });
    const compatible = vm({
      name: 'Standard_D4ads_v5',
      family: 'standardDADSv5Family',
      tempDiskMB: 76800,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.14)
    });

    const result = engine(source, noTempDisk, compatible)
      .findRecommendations(source.name, 'westeurope', 'linux');

    expect(result.recommendation?.vm.name).toBe('Standard_D4ads_v5');
    expect(result.rejected.tempDisk).toBe(1);
  });

  it('preserves usable vCPU for a constrained-vCPU source without favoring physical CPU count', () => {
    const source = vm({
      name: 'Standard_E16-4as_v4',
      vcpus: 16,
      vcpusAvailable: 4,
      memoryGB: 128,
      cpuVendor: 'AMD',
      cpuGeneration: 2,
      prices: prices(0.9)
    });
    const constrained = vm({
      name: 'Standard_E16-4as_v5',
      vcpus: 16,
      vcpusAvailable: 4,
      memoryGB: 128,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.7)
    });
    const fullCpu = vm({
      name: 'Standard_E16as_v5',
      vcpus: 16,
      vcpusAvailable: 16,
      memoryGB: 128,
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.69)
    });

    const result = engine(source, fullCpu, constrained)
      .findRecommendations(source.name, 'westeurope', 'linux');

    expect(result.recommendation?.vm.name).toBe('Standard_E16-4as_v5');
  });

  it('finds source SKUs case-insensitively', () => {
    const source = vm({ name: 'Standard_DS3_v2' });
    const replacement = vm({ name: 'Standard_D4s_v5', cpuGeneration: 4, prices: prices(0.15) });
    const result = engine(source, replacement)
      .findRecommendations('standard_ds3_V2', 'westeurope', 'linux');
    expect(result.source?.name).toBe('Standard_DS3_v2');
  });

  it('enforces same-vendor CPU policy as a hard filter', () => {
    const source = vm({ cpuVendor: 'AMD', cpuGeneration: 2 });
    const intel = vm({
      name: 'Standard_D4s_v5',
      cpuVendor: 'Intel',
      cpuGeneration: 4,
      prices: prices(0.1)
    });
    const amd = vm({
      name: 'Standard_D4as_v5',
      cpuVendor: 'AMD',
      cpuGeneration: 3,
      prices: prices(0.2)
    });
    const result = engine(source, intel, amd)
      .findRecommendations(source.name, 'westeurope', 'linux', 'same-vendor');
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
    const result = engine(source, vm({ name: 'Standard_D4s_v5' }))
      .findRecommendations(source.name, 'westeurope', 'linux');
    expect(result.status).toBe('incomplete-capabilities');
    expect(result.confidence).toBe('Low');
  });

  it('requires a usable price for the selected operating system', () => {
    const source = vm({});
    const linuxOnly = vm({
      name: 'Standard_D4s_v5',
      prices: {
        ...prices(0.15),
        windowsPaygHourly: null
      }
    });

    const result = engine(source, linuxOnly)
      .findRecommendations(source.name, 'westeurope', 'windows');
    expect(result.status).toBe('no-compatible-replacement');
    expect(result.rejected.price).toBe(1);
  });

  it('still recommends compatible hardware when the retired source has no current price', () => {
    const source = vm({
      prices: {
        ...prices(),
        linuxPaygHourly: null
      }
    });
    const replacement = vm({
      name: 'Standard_D4ads_v5',
      tempDiskMB: 76800,
      cpuGeneration: 3,
      prices: prices(0.15)
    });
    const result = engine(source, replacement)
      .findRecommendations(source.name, 'westeurope', 'linux');
    expect(result.status).toBe('source-price-missing');
    expect(result.recommendation?.vm.name).toBe('Standard_D4ads_v5');
    expect(result.recommendation?.monthlySaving).toBeNull();
  });

  it('creates every source and CPU-policy quality-check combination for Linux', () => {
    const matrix = engine(vm({}), vm({ name: 'Standard_D4s_v5' })).createQualityMatrix();
    expect(matrix).toHaveLength(6);
    expect(new Set(matrix.map((row) => row.os))).toEqual(new Set(['linux']));
    expect(new Set(matrix.map((row) => row.cpuPolicy))).toEqual(
      new Set(['same-vendor', 'prefer-same-vendor', 'any-compatible'])
    );
  });
});

function engine(...skus: VmSku[]): RecommendationEngine {
  const catalog: RegionalCatalog = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    currencyCode: 'EUR',
    region: 'westeurope',
    displayName: 'West Europe',
    skus
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
    windowsReservation3Year: null
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
    prices: prices(),
    ...overrides
  };
}
