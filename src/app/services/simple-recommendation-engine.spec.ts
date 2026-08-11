import { EMPTY_PROFILE, prices, region, vm } from './vm.fixtures';
import { SimpleRecommendationEngine } from './simple-recommendation-engine';
import { VmSku } from '../models/vm.models';

const run = (source: VmSku, skus: VmSku[]) =>
  new SimpleRecommendationEngine(region(skus)).recommend(source.name, 'linux');

const intel = {
  cpuVendor: 'Intel',
  cpuArchitecture: 'x64',
  cpuModel: 'Intel Xeon Platinum 8370C (Ice Lake)',
  architecture: 'x64',
} as const;

const base = { ...intel, profile: { ...EMPTY_PROFILE }, tempDiskMB: 0, workloadFamily: 'D' };

describe('SimpleRecommendationEngine', () => {
  it('reports an unknown source SKU', () => {
    const result = new SimpleRecommendationEngine(region([vm()])).recommend('Standard_Nope');

    expect(result.outcome).toBe('source-not-found');
    expect(result.reason).toBe('Source VM not found');
    expect(result.targetVm).toBe('Standard_Nope');
  });

  it('keeps a supported VM when nothing compatible is cheaper', () => {
    const source = vm({ ...base, name: 'Standard_D2s_v5', seriesVersion: 5, prices: prices(0.1) });
    const pricier = vm({
      ...base,
      name: 'Standard_D2s_v6',
      seriesVersion: 6,
      prices: prices(0.2),
    });

    const result = run(source, [source, pricier]);

    expect(result.outcome).toBe('keep');
    expect(result.targetVm).toBe('Standard_D2s_v5');
  });

  it('recommends a cheaper compatible VM of the same shape', () => {
    const source = vm({ ...base, name: 'Standard_D2s_v5', seriesVersion: 5, prices: prices(0.1) });
    const cheaper = vm({
      ...base,
      name: 'Standard_D2s_v6',
      seriesVersion: 6,
      prices: prices(0.08),
    });

    const result = run(source, [source, cheaper]);

    expect(result.outcome).toBe('cost-optimization');
    expect(result.targetVm).toBe('Standard_D2s_v6');
    expect(result.reason).toBe('Cost optimization: 20.0% cheaper with equivalent capabilities');
  });

  it('prefers the closest shape over the absolute cheapest candidate', () => {
    const source = vm({
      ...base,
      name: 'Standard_D4s_v5',
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 16,
      seriesVersion: 5,
      prices: prices(0.2),
    });
    const sameShape = vm({
      ...base,
      name: 'Standard_D4s_v6',
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 16,
      seriesVersion: 6,
      prices: prices(0.18),
    });
    const bigger = vm({
      ...base,
      name: 'Standard_D8s_v6',
      vcpus: 8,
      vcpusAvailable: 8,
      memoryGB: 32,
      seriesVersion: 6,
      prices: prices(0.1),
    });

    const result = run(source, [source, sameShape, bigger]);

    expect(result.targetVm).toBe('Standard_D4s_v6');
  });

  it('never reduces vCPU, memory or capabilities', () => {
    const source = vm({
      ...base,
      name: 'Standard_D4s_v5',
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 16,
      premiumIO: true,
      seriesVersion: 5,
      prices: prices(0.2),
    });
    const smaller = vm({
      ...base,
      name: 'Standard_D2s_v6',
      vcpus: 2,
      vcpusAvailable: 2,
      memoryGB: 8,
      seriesVersion: 6,
      prices: prices(0.05),
    });
    const noPremiumIo = vm({
      ...base,
      name: 'Standard_D4_v6',
      vcpus: 4,
      vcpusAvailable: 4,
      memoryGB: 16,
      premiumIO: false,
      seriesVersion: 6,
      prices: prices(0.05),
    });

    const result = run(source, [source, smaller, noPremiumIo]);

    expect(result.outcome).toBe('keep');
    expect(result.targetVm).toBe('Standard_D4s_v5');
  });

  it('never crosses the CPU vendor or the workload type', () => {
    const source = vm({ ...base, name: 'Standard_D2s_v5', seriesVersion: 5, prices: prices(0.1) });
    const amd = vm({
      ...base,
      cpuVendor: 'AMD',
      cpuModel: 'AMD EPYC 9004 (Genoa)',
      name: 'Standard_D2as_v6',
      seriesVersion: 6,
      prices: prices(0.05),
    });
    const memoryOptimized = vm({
      ...base,
      name: 'Standard_E2s_v6',
      workloadFamily: 'E',
      seriesVersion: 6,
      prices: prices(0.05),
    });

    const result = run(source, [source, amd, memoryOptimized]);

    expect(result.outcome).toBe('keep');
    expect(result.targetVm).toBe('Standard_D2s_v5');
  });

  it('migrates an EOL source even when the replacement is not cheaper', () => {
    const source = vm({
      ...base,
      name: 'Standard_D2_v2',
      seriesVersion: 2,
      lifecycleStatus: 'retirementAnnounced',
      retirement: {
        eolDate: '2028-11-15',
        description: 'Dv2 retirement',
        sourceUrl: 'https://learn.microsoft.com',
      },
      prices: prices(0.1),
    });
    const successor = vm({
      ...base,
      name: 'Standard_D2s_v5',
      seriesVersion: 5,
      prices: prices(0.12),
    });

    const result = run(source, [source, successor]);

    expect(result.outcome).toBe('eol-migration');
    expect(result.targetVm).toBe('Standard_D2s_v5');
    expect(result.reason).toBe('EOL migration: cheapest compatible replacement');
  });

  it('reports when an EOL source has no compatible replacement', () => {
    const source = vm({
      ...base,
      name: 'Standard_D2_v2',
      seriesVersion: 2,
      lifecycleStatus: 'retired',
      prices: prices(0.1),
    });

    const result = run(source, [source]);

    expect(result.outcome).toBe('no-compatible-replacement');
    expect(result.targetVm).toBe('Standard_D2_v2');
  });

  it('ignores candidates that are retired or restricted in the region', () => {
    const source = vm({ ...base, name: 'Standard_D2s_v5', seriesVersion: 5, prices: prices(0.1) });
    const retiredCandidate = vm({
      ...base,
      name: 'Standard_D2s_v4',
      seriesVersion: 4,
      lifecycleStatus: 'retired',
      prices: prices(0.05),
    });
    const restricted = vm({
      ...base,
      name: 'Standard_D2s_v6',
      seriesVersion: 6,
      prices: prices(0.05),
      restrictions: [
        { type: 'Location', reasonCode: 'NotAvailableForSubscription', values: ['westeurope'] },
      ],
    });

    const result = run(source, [source, retiredCandidate, restricted]);

    expect(result.outcome).toBe('keep');
    expect(result.targetVm).toBe('Standard_D2s_v5');
  });

  it('breaks a tie on price by preferring the newer generation', () => {
    const source = vm({
      ...base,
      name: 'Standard_D2_v3',
      seriesVersion: 3,
      cpuGeneration: 1,
      prices: prices(0.1),
    });
    const older = vm({
      ...base,
      name: 'Standard_D2_v4',
      seriesVersion: 4,
      cpuGeneration: 2,
      prices: prices(0.08),
    });
    const newer = vm({
      ...base,
      name: 'Standard_D2_v5',
      seriesVersion: 5,
      cpuGeneration: 3,
      prices: prices(0.08),
    });

    const result = run(source, [source, older, newer]);

    expect(result.targetVm).toBe('Standard_D2_v5');
  });
});
