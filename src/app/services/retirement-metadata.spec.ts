import { RegionalCatalog, RetirementCatalog, VmSku } from '../models/vm.models';
import { applyRetirementMetadata } from './retirement-metadata';

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
});

function retirement(eolDate: string) {
  return {
    eolDate,
    description: 'Test retirement',
    sourceUrl: 'https://learn.microsoft.com/',
  };
}

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
    name: 'Standard_DS3_v2',
    family: 'standardDSv2Family',
    region: 'uksouth',
    tier: 'Standard',
    vcpus: 4,
    vcpusAvailable: 4,
    gpus: 0,
    memoryGB: 14,
    tempDiskMB: 28672,
    maxDataDisks: 16,
    maxNICs: 4,
    premiumIO: true,
    acceleratedNetworking: true,
    ephemeralOSDisk: false,
    rdma: false,
    architecture: 'x64',
    hyperVGenerations: ['V1'],
    cpuVendor: 'Intel',
    cpuGeneration: 1,
    zones: [],
    restrictions: [],
    retirement: null,
    workloadClass: null,
    prices: {
      linuxPaygHourly: null,
      windowsPaygHourly: null,
      linuxReservation1Year: null,
      linuxReservation3Year: null,
      windowsReservation1Year: null,
      windowsReservation3Year: null,
    },
  };
}
