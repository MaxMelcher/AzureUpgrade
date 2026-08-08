import { RegionalCatalog, RetirementCatalog, VmSku } from '../models/vm.models';
import { applyRetirementMetadata, applyLifecycleStatus } from './retirement-metadata';
import { region as regionOf, vm as baseVm } from './vm.fixtures';

describe('applyRetirementMetadata', () => {
  it('matches authoritative family identifiers case-insensitively', () => {
    const catalog = applyRetirementMetadata(region(vm()), {
      families: {
        standarddsv2family: retirement('2028-05-01'),
      },
      skus: {},
    });
    expect(catalog.skus[0].retirement?.eolDate).toBe('2028-05-01');
  });

  it('prefers an exact SKU retirement over its family retirement', () => {
    const metadata: RetirementCatalog = {
      families: {
        standardDSv2Family: retirement('2028-05-01'),
      },
      skus: {
        Standard_DS3_v2: retirement('2027-01-01'),
      },
    };
    const catalog = applyRetirementMetadata(region(vm()), metadata);
    expect(catalog.skus[0].retirement?.eolDate).toBe('2027-01-01');
  });

  it('applies an authoritative regional EOL override', () => {
    const metadata: RetirementCatalog = {
      families: {
        standardDSv2Family: {
          ...retirement('2025-01-01'),
          regionEolDates: { uksouth: '2028-05-01' },
        },
      },
      skus: {},
    };
    const catalog = applyRetirementMetadata(region(vm()), metadata);
    expect(catalog.skus[0].retirement?.eolDate).toBe('2028-05-01');
  });

  it('classifies lifecycle status from the newest series in the catalog', () => {
    const previous = baseVm({
      name: 'Standard_D4s_v5',
      family: 'standardDSv5Family',
      seriesVersion: 5,
      cpuVendor: 'Intel',
      cpuArchitecture: 'x64',
    });
    const current = baseVm({
      name: 'Standard_D4s_v6',
      family: 'StandardDsv6Family',
      seriesVersion: 6,
      cpuVendor: 'Intel',
      cpuArchitecture: 'x64',
    });
    const retiring = baseVm({
      name: 'Standard_D4_v2',
      family: 'standardDv2Family',
      seriesVersion: 2,
      cpuVendor: 'Intel',
      cpuArchitecture: 'x64',
      retirement: retirement('2028-05-01'),
    });

    const catalog = applyLifecycleStatus(regionOf([previous, current, retiring]));
    const status = (name: string) =>
      catalog.skus.find((sku) => sku.name === name)?.lifecycleStatus;

    expect(status('Standard_D4s_v6')).toBe('current');
    expect(status('Standard_D4s_v5')).toBe('previousGeneration');
    expect(status('Standard_D4_v2')).toBe('retirementAnnounced');
  });
});

function retirement(eolDate: string) {
  return {
    eolDate,
    description: 'Test retirement',
    sourceUrl: 'https://learn.microsoft.com/',
  };
}

function region(sku: VmSku): RegionalCatalog {
  return regionOf([sku], { currencyCode: 'GBP', region: 'uksouth', displayName: 'UK South' });
}

function vm(): VmSku {
  return baseVm({
    name: 'Standard_DS3_v2',
    family: 'standardDSv2Family',
    region: 'uksouth',
    cpuVendor: 'Intel',
    cpuModel: 'Intel Xeon (Haswell/Broadwell)',
    cpuGeneration: 1,
    workloadFamily: 'D',
    seriesVersion: 2,
  });
}
