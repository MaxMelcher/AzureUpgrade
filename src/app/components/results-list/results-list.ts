import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { CandidateRecommendation, RecommendationResult, VmSku } from '../../models/vm.models';

@Component({
  selector: 'app-results-list',
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './results-list.html',
  styleUrl: './results-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ResultsListComponent {
  public readonly results = input.required<RecommendationResult[]>();
  public readonly regionName = input.required<string>();
  public readonly currencyCode = input.required<string>();
  public readonly busyMatrix = input(false);
  public readonly copyResults = output<void>();
  public readonly downloadCsv = output<void>();
  public readonly downloadMatrix = output<void>();
  protected readonly expanded = signal(new Set<number>());

  protected toggle(index: number): void {
    const updated = new Set(this.expanded());
    updated.has(index) ? updated.delete(index) : updated.add(index);
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
    return value === null ? 'Unknown' : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  }
}
