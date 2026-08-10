import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import {
  CandidateRecommendation,
  CompatibilityCheck,
  RecommendationResult,
  RecommendationStatus,
  VmSku,
} from '../../models/vm.models';

interface CandidateList {
  key: string;
  title: string;
  candidates: CandidateRecommendation[];
}

interface ResultGroup {
  key: string;
  title: string;
  description: string;
  results: RecommendationResult[];
}

@Component({
  selector: 'app-results-list',
  imports: [CurrencyPipe, DatePipe, DecimalPipe],
  templateUrl: './results-list.html',
  styleUrl: './results-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultsListComponent {
  public readonly results = input.required<RecommendationResult[]>();
  public readonly regionName = input.required<string>();
  public readonly currencyCode = input.required<string>();
  public readonly busyMatrix = input(false);
  public readonly copyResults = output<void>();
  public readonly downloadCsv = output<void>();
  public readonly downloadMatrix = output<void>();
  protected readonly expanded = signal(new Set<string>());
  protected readonly collapsedGroups = signal(new Set<string>());
  protected readonly resultGroups = computed<ResultGroup[]>(() => {
    const sorted = [...this.results()].sort(
      (left, right) =>
        (right.recommendation?.monthlySaving ?? Number.NEGATIVE_INFINITY) -
        (left.recommendation?.monthlySaving ?? Number.NEGATIVE_INFINITY),
    );
    const inState = (...states: RecommendationStatus[]): RecommendationResult[] =>
      sorted.filter((result) => states.includes(result.status));

    return [
      {
        key: 'cost',
        title: 'Cost optimizations',
        description: 'Fully compatible replacements that are at least 5% cheaper.',
        results: inState('recommended').filter((result) => !result.mandatoryUpgrade),
      },
      {
        key: 'lifecycle',
        title: 'Lifecycle replacements',
        description:
          'Retired or retiring VM sizes that must be replaced. A lifecycle replacement is not a cost optimization.',
        results: sorted.filter(
          (result) =>
            result.mandatoryUpgrade ||
            result.status === 'lifecycle-replacement' ||
            result.status === 'manual-migration-required',
        ),
      },
      {
        key: 'keep',
        title: 'Keep current size',
        description:
          'Supported VM sizes with no fully compatible alternative offering material savings.',
        results: inState('keep'),
      },
      {
        key: 'review',
        title: 'Manual review',
        description:
          'No compatible cheaper replacement. Alternative architectures and profile changes are listed for manual review.',
        results: inState(
          'no-safe-cheaper-replacement',
          'manual-review',
          'alternative-architecture',
        ).filter((result) => !result.mandatoryUpgrade),
      },
      {
        key: 'unknown',
        title: 'Not analyzed',
        description: 'VM sizes that are unknown in this region or lack authoritative capabilities.',
        results: inState('sku-not-found', 'incomplete-capabilities'),
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

  protected price(result: RecommendationResult, vm: VmSku): number | null {
    return result.os === 'linux' ? vm.prices.linuxPaygHourly : vm.prices.windowsPaygHourly;
  }

  protected savingClass(candidate: CandidateRecommendation | null): string {
    return (candidate?.monthlySaving ?? 0) >= 0 ? 'positive' : 'negative';
  }

  protected yesNo(value: boolean | null): string {
    return value === null ? 'Unknown' : value ? 'Yes' : 'No';
  }

  protected localStorage(vm: VmSku | null | undefined): string {
    if (!vm) return 'Unknown';
    if (!vm.profile.localTempDisk) return 'None';
    return (vm.tempDiskMB ?? 0) > 0 ? this.gbFromMb(vm.tempDiskMB) : 'Included';
  }

  protected absolute(value: number): number {
    return Math.abs(value);
  }

  protected candidateLists(result: RecommendationResult): CandidateList[] {
    return [
      { key: 'alternatives', title: 'Alternative candidates', candidates: result.alternatives },
      {
        key: 'architecture',
        title: 'Alternative architecture – never selected automatically',
        candidates: result.alternativeArchitecture,
      },
      { key: 'review', title: 'Manual review', candidates: result.manualReview },
    ].filter((list) => list.candidates.length > 0);
  }

  protected badges(candidate: CandidateRecommendation): CompatibilityCheck[] {
    return candidate.checks;
  }

  protected stateLabel(result: RecommendationResult): string {
    return (
      {
        keep: 'Keep',
        recommended: 'Recommended',
        'lifecycle-replacement': 'Lifecycle replacement – not a cost saving',
        'alternative-architecture': 'Alternative architecture',
        'manual-review': 'Manual review',
        'manual-migration-required': 'Manual migration required',
        'no-safe-cheaper-replacement': 'No safe cheaper replacement',
        'sku-not-found': 'VM size not found',
        'incomplete-capabilities': 'Incomplete Azure metadata',
      } as Record<RecommendationStatus, string>
    )[result.status];
  }

  protected accelerator(vm: VmSku | null | undefined): string {
    if (!vm) return 'Unknown';
    if (!vm.accelerator && (vm.gpus ?? 0) === 0) return 'None';
    return vm.accelerator
      ? `${vm.gpus ?? '?'}× ${vm.accelerator.vendor} ${vm.accelerator.model}`
      : `${vm.gpus} GPU`;
  }

  protected generation(vm: VmSku | null | undefined): string {
    if (!vm) return 'Unknown';
    return vm.workloadFamily && vm.seriesVersion
      ? `${vm.workloadFamily}v${vm.seriesVersion}`
      : vm.family;
  }

  protected gbFromMb(value: number | null): string {
    return value === null
      ? 'Unknown'
      : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  }
}
