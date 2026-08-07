import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CandidateRecommendation, RecommendationResult, VmSku } from '../../models/vm.models';

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
  protected readonly resultGroups = computed<ResultGroup[]>(() => {
    const sorted = [...this.results()].sort(
      (left, right) =>
        (right.recommendation?.monthlySaving ?? Number.NEGATIVE_INFINITY) -
        (left.recommendation?.monthlySaving ?? Number.NEGATIVE_INFINITY),
    );
    const mandatory = sorted.filter((result) => result.mandatoryUpgrade);
    const saving = sorted.filter(
      (result) => !result.mandatoryUpgrade && (result.recommendation?.monthlySaving ?? 0) > 0.005,
    );
    const neutral = sorted.filter(
      (result) =>
        !result.mandatoryUpgrade &&
        result.recommendation?.monthlySaving !== null &&
        result.recommendation !== null &&
        Math.abs(result.recommendation.monthlySaving) <= 0.005,
    );
    const increase = sorted.filter(
      (result) =>
        !result.mandatoryUpgrade &&
        result.recommendation?.monthlySaving !== null &&
        result.recommendation !== null &&
        result.recommendation.monthlySaving < -0.005,
    );
    const unavailable = sorted.filter(
      (result) =>
        !result.mandatoryUpgrade &&
        (result.recommendation === null || result.recommendation.monthlySaving === null),
    );

    return [
      {
        key: 'mandatory',
        title: 'Mandatory upgrades',
        description: 'Retired VM sizes that must be replaced, ordered by monthly saving.',
        results: mandatory,
      },
      {
        key: 'saving',
        title: 'Monthly savings',
        description: 'Compatible upgrades ordered from highest to lowest estimated monthly saving.',
        results: saving,
      },
      {
        key: 'neutral',
        title: 'No monthly price change',
        description: 'Compatible upgrades with no material monthly retail price difference.',
        results: neutral,
      },
      {
        key: 'increase',
        title: 'Monthly cost increase',
        description: 'Compatible upgrades with a strictly higher estimated monthly cost.',
        results: increase,
      },
      {
        key: 'unavailable',
        title: 'Savings unavailable',
        description: 'Sources without a current price or compatible recommendation.',
        results: unavailable,
      },
    ].filter((group) => group.results.length > 0);
  });

  protected toggle(sku: string): void {
    const updated = new Set(this.expanded());
    updated.has(sku) ? updated.delete(sku) : updated.add(sku);
    this.expanded.set(updated);
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

  protected gbFromMb(value: number | null): string {
    return value === null
      ? 'Unknown'
      : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  }
}
