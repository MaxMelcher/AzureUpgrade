import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { VmSku } from '../../models/vm.models';
import { Recommendation, SimpleOutcome } from '../../services/recommendation-engine';

interface ResultGroup {
  key: string;
  title: string;
  description: string;
  results: Recommendation[];
}

@Component({
  selector: 'app-results-list',
  imports: [CurrencyPipe, DatePipe, DecimalPipe],
  templateUrl: './results-list.html',
  styleUrl: './results-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultsListComponent {
  public readonly results = input.required<Recommendation[]>();
  public readonly skus = input.required<VmSku[]>();
  public readonly regionName = input.required<string>();
  public readonly currencyCode = input.required<string>();
  public readonly busyMatrix = input(false);
  public readonly tempDiskRelaxationAvailable = input(false);
  public readonly copyResults = output<void>();
  public readonly downloadCsv = output<void>();
  public readonly downloadMatrix = output<void>();
  protected readonly expanded = signal(new Set<string>());
  protected readonly collapsedGroups = signal(new Set<string>());
  private readonly skuLookup = computed(
    () => new Map(this.skus().map((sku) => [sku.name.toLowerCase(), sku])),
  );
  protected readonly resultGroups = computed<ResultGroup[]>(() => {
    const sorted = [...this.results()].sort(
      (left, right) => (right.savingPercent ?? Number.NEGATIVE_INFINITY) -
        (left.savingPercent ?? Number.NEGATIVE_INFINITY),
    );
    const outcomes = (...values: SimpleOutcome[]): Recommendation[] =>
      sorted.filter((result) => values.includes(result.outcome));

    return [
      {
        key: 'cost',
        title: 'Cost optimizations',
        description: 'Cheaper targets that pass every compatibility rule.',
        results: outcomes('cost-optimization'),
      },
      {
        key: 'lifecycle',
        title: 'Lifecycle replacements',
        description: 'Retired or retiring VM sizes with a compatible replacement.',
        results: outcomes('eol-migration'),
      },
      {
        key: 'keep',
        title: 'Keep current size',
        description: 'Supported VM sizes with no cheaper compatible replacement.',
        results: outcomes('keep'),
      },
      {
        key: 'review',
        title: 'Manual review',
        description: 'Unknown sources or VM sizes for which no compatible replacement exists.',
        results: outcomes('source-not-found', 'no-compatible-replacement'),
      },
    ].filter((group) => group.results.length > 0);
  });

  protected toggle(sku: string): void {
    const updated = new Set(this.expanded());
    updated.has(sku) ? updated.delete(sku) : updated.add(sku);
    this.expanded.set(updated);
  }

  protected toggleGroup(groupKey: string): void {
    const updated = new Set(this.collapsedGroups());
    updated.has(groupKey) ? updated.delete(groupKey) : updated.add(groupKey);
    this.collapsedGroups.set(updated);
  }

  protected source(result: Recommendation): VmSku | null {
    return this.skuLookup().get(result.sourceVm.toLowerCase()) ?? null;
  }

  protected target(result: Recommendation): VmSku | null {
    if (this.isFailure(result)) return null;
    return this.skuLookup().get(result.targetVm.toLowerCase()) ?? null;
  }

  protected isFailure(result: Recommendation): boolean {
    return result.outcome === 'source-not-found' || result.outcome === 'no-compatible-replacement';
  }

  protected dropsTempDisk(result: Recommendation): boolean {
    return this.source(result)?.profile.localTempDisk === true &&
      this.target(result)?.profile.localTempDisk === false;
  }

  protected stateLabel(result: Recommendation): string {
    return ({
      'source-not-found': 'VM size not found',
      'no-compatible-replacement': 'No compatible replacement',
      'eol-migration': 'Lifecycle replacement',
      'cost-optimization': 'Cost optimization',
      keep: 'Keep',
    } as Record<SimpleOutcome, string>)[result.outcome];
  }

  protected localStorage(vm: VmSku | null): string {
    if (!vm) return 'Unknown';
    if (!vm.profile.localTempDisk) return 'None';
    return (vm.tempDiskMB ?? 0) > 0 ? this.gbFromMb(vm.tempDiskMB) : 'Included';
  }

  protected yesNo(value: boolean | null): string {
    return value === null ? 'Unknown' : value ? 'Yes' : 'No';
  }

  protected accelerator(vm: VmSku | null): string {
    if (!vm) return 'Unknown';
    if (!vm.accelerator && (vm.gpus ?? 0) === 0) return 'None';
    return vm.accelerator
      ? `${vm.gpus ?? '?'}× ${vm.accelerator.vendor} ${vm.accelerator.model}`
      : `${vm.gpus} GPU`;
  }

  protected generation(vm: VmSku | null): string {
    if (!vm) return 'Unknown';
    return vm.workloadFamily && vm.seriesVersion
      ? `${vm.workloadFamily}v${vm.seriesVersion}`
      : vm.family;
  }

  protected monthlySaving(result: Recommendation): number | null {
    return result.sourceHourlyPrice !== null && result.targetHourlyPrice !== null
      ? (result.sourceHourlyPrice - result.targetHourlyPrice) * 730
      : null;
  }

  protected gbFromMb(value: number | null): string {
    return value === null
      ? 'Unknown'
      : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  }
}
