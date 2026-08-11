import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyCode, OperatingSystem, RegionInfo, VmSku } from '../../models/vm.models';
import { CatalogService } from '../../services/catalog.service';
import {
  Recommendation,
  RecommendationEngine,
  representativeSkus,
} from '../../services/recommendation-engine';

type ApprovalDecision = 'correct' | 'incorrect';
type ApprovalFilter = 'all' | 'unreviewed' | ApprovalDecision;

@Component({
  selector: 'app-approval-matrix',
  imports: [CurrencyPipe, DecimalPipe, FormsModule],
  templateUrl: './approval-matrix.html',
  styleUrl: './approval-matrix.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApprovalMatrixComponent {
  private readonly catalogService = inject(CatalogService);
  private readonly storageKey = 'azure-vm-upgrade-advisor.approvals.v2';
  private readonly correctionStorageKey = 'azure-vm-upgrade-advisor.corrections.v2';
  private initialized = false;

  public readonly regions = input.required<RegionInfo[]>();

  protected region = 'uksouth';
  protected currency: CurrencyCode = 'GBP';
  protected os: OperatingSystem = 'linux';
  protected keepTempDisk = true;
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly catalogGeneratedAt = signal('');
  protected readonly catalogSkus = signal<VmSku[]>([]);
  protected readonly results = signal<Recommendation[]>([]);
  protected readonly filter = signal<ApprovalFilter>('all');
  protected readonly decisions = signal<Record<string, ApprovalDecision>>(this.readDecisions());
  protected readonly corrections = signal<Record<string, string>>(this.readCorrections());
  protected readonly correctionSearches = signal<Record<string, string>>({});
  protected readonly noRecommendationValue = '__no_recommendation__';
  protected readonly visibleResults = computed(() => {
    const filter = this.filter();
    if (filter === 'all') return this.results();
    return this.results().filter((result) => {
      const decision = this.decision(result);
      return filter === 'unreviewed' ? decision === null : decision === filter;
    });
  });
  protected readonly counts = computed(() => {
    let correct = 0;
    let incorrect = 0;
    let correctionsSpecified = 0;
    for (const result of this.results()) {
      const decision = this.decision(result);
      if (decision === 'correct') correct++;
      if (decision === 'incorrect') {
        incorrect++;
        if (this.correction(result) !== '') correctionsSpecified++;
      }
    }
    return {
      total: this.results().length,
      correct,
      incorrect,
      correctionsSpecified,
      correctionsMissing: incorrect - correctionsSpecified,
      unreviewed: this.results().length - correct - incorrect,
    };
  });

  public constructor() {
    effect(() => {
      const regions = this.regions();
      if (this.initialized || regions.length === 0) return;
      this.initialized = true;
      const query = new URLSearchParams(window.location.search);
      const requestedRegion = query.get('region')?.toLowerCase();
      const requestedCurrency = query.get('currency')?.toUpperCase();
      const requestedOs = query.get('os');
      if (requestedRegion && regions.some((item) => item.name === requestedRegion)) {
        this.region = requestedRegion;
      }
      if (requestedCurrency === 'GBP' || requestedCurrency === 'EUR' || requestedCurrency === 'USD') {
        this.currency = requestedCurrency;
      }
      if (requestedOs === 'linux' || requestedOs === 'windows') this.os = requestedOs;
      this.keepTempDisk = query.get('keepTempDisk') !== 'false';
      this.load();
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.results.set([]);
    this.updateUrl();
    this.catalogService.loadRegion(this.region, this.currency).subscribe({
      next: (catalog) => {
        const engine = new RecommendationEngine(catalog);
        this.catalogGeneratedAt.set(catalog.generatedAt);
        this.catalogSkus.set([...catalog.skus].sort((left, right) => left.name.localeCompare(right.name)));
        this.results.set(
          representativeSkus(catalog, this.os).map((sku) =>
            engine.recommend(
              sku.name,
              this.os,
              this.os === 'linux' ? this.keepTempDisk : true,
            ),
          ),
        );
        this.loading.set(false);
      },
      error: () => {
        this.error.set('The generated catalog for this approval matrix could not be loaded.');
        this.loading.set(false);
      },
    });
  }

  protected source(result: Recommendation): VmSku | null {
    return this.catalogSkus().find((sku) => sku.name === result.sourceVm) ?? null;
  }

  protected target(result: Recommendation): VmSku | null {
    if (result.outcome === 'source-not-found' || result.outcome === 'no-compatible-replacement') {
      return null;
    }
    return this.catalogSkus().find((sku) => sku.name === result.targetVm) ?? null;
  }

  protected setDecision(result: Recommendation, decision: ApprovalDecision): void {
    const key = this.reviewKey(result);
    const updated = { ...this.decisions() };
    if (updated[key] === decision) delete updated[key];
    else updated[key] = decision;
    this.decisions.set(updated);
    this.persistDecisions(updated);
  }

  protected decision(result: Recommendation): ApprovalDecision | null {
    return this.decisions()[this.reviewKey(result)] ?? null;
  }

  protected setCorrection(result: Recommendation, recommendation: string): void {
    if (
      recommendation !== '' &&
      recommendation !== this.noRecommendationValue &&
      !this.catalogSkus().some((sku) => sku.name === recommendation)
    ) {
      console.warn(`Ignoring invalid corrected recommendation: ${recommendation}`);
      return;
    }
    const key = this.reviewKey(result);
    const updated = { ...this.corrections() };
    if (recommendation === '') delete updated[key];
    else updated[key] = recommendation;
    this.corrections.set(updated);
    this.persistCorrections(updated);
    if (recommendation !== '') this.setCorrectionSearch(result, '');
  }

  protected correction(result: Recommendation): string {
    const correction = this.corrections()[this.reviewKey(result)] ?? '';
    if (correction === '' || correction === this.noRecommendationValue) return correction;
    return this.catalogSkus().some((sku) => sku.name === correction) ? correction : '';
  }

  protected setCorrectionSearch(result: Recommendation, search: string): void {
    const key = this.reviewKey(result);
    this.correctionSearches.update((values) => ({ ...values, [key]: search }));
  }

  protected correctionSearch(result: Recommendation): string {
    return this.correctionSearches()[this.reviewKey(result)] ?? '';
  }

  protected correctionOptions(result: Recommendation): VmSku[] {
    const query = this.correctionSearch(result).trim().toLowerCase();
    if (query === '') {
      const selected = this.correction(result);
      if (selected === '' || selected === this.noRecommendationValue) return [];
      return this.catalogSkus().filter((sku) => sku.name === selected);
    }
    return this.catalogSkus().filter(
      (sku) => sku.name.toLowerCase().includes(query) || sku.family.toLowerCase().includes(query),
    );
  }

  protected family(result: Recommendation): string {
    return this.source(result)?.family ?? 'Unknown family';
  }

  protected downloadSnapshot(): void {
    const snapshot = {
      schemaVersion: 6,
      engine: 'declarative-rule-based',
      configuration: {
        region: this.region,
        currency: this.currency,
        os: this.os,
        keepTempDisk: this.os === 'linux' ? this.keepTempDisk : true,
      },
      summary: this.counts(),
      rows: this.results().map((result) => {
        const correction = this.correction(result);
        const correctionSpecified = this.decision(result) === 'incorrect' && correction !== '';
        return {
          reviewKey: this.reviewKey(result),
          verdict: this.decision(result),
          expectedRecommendationSpecified: correctionSpecified,
          expectedRecommendationKind: correctionSpecified
            ? correction === this.noRecommendationValue ? 'none' : 'sku'
            : null,
          expectedRecommendation:
            correctionSpecified && correction !== this.noRecommendationValue ? correction : null,
          family: this.family(result),
          source: result.sourceVm,
          recommendation: this.target(result)?.name ?? null,
          outcome: result.outcome,
          lifecycle: this.source(result)?.lifecycleStatus ?? null,
          sourceHourly: result.sourceHourlyPrice,
          recommendedHourly: result.targetHourlyPrice,
          savingPercent: result.savingPercent,
          candidateCount: result.candidateCount,
          compatibleCandidates: result.compatibleCandidates,
          reason: result.reason,
          migrationGuideUrl: result.migrationGuideUrl,
        };
      }),
    };
    const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `recommendation-approvals-${this.region}-${this.os}-${this.currency.toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private reviewKey(result: Recommendation): string {
    return [
      this.region,
      this.currency,
      this.os,
      Number(this.os === 'linux' ? this.keepTempDisk : true),
      this.family(result),
      result.sourceVm,
      this.target(result)?.name ?? 'none',
      result.outcome,
    ].join('|');
  }

  private updateUrl(): void {
    const query = new URLSearchParams({
      view: 'approval',
      region: this.region,
      currency: this.currency,
      os: this.os,
      keepTempDisk: String(this.os === 'linux' ? this.keepTempDisk : true),
    });
    window.history.replaceState(null, '', `${window.location.pathname}?${query}`);
  }

  private readDecisions(): Record<string, ApprovalDecision> {
    try {
      const value = JSON.parse(localStorage.getItem(this.storageKey) ?? '{}') as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, ApprovalDecision] =>
            entry[1] === 'correct' || entry[1] === 'incorrect',
        ),
      );
    } catch {
      return {};
    }
  }

  private persistDecisions(decisions: Record<string, ApprovalDecision>): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(decisions));
    } catch (error) {
      console.warn('Unable to persist recommendation approvals.', error);
    }
  }

  private readCorrections(): Record<string, string> {
    try {
      const value = JSON.parse(localStorage.getItem(this.correctionStorageKey) ?? '{}') as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
        ),
      );
    } catch {
      return {};
    }
  }

  private persistCorrections(corrections: Record<string, string>): void {
    try {
      localStorage.setItem(this.correctionStorageKey, JSON.stringify(corrections));
    } catch (error) {
      console.warn('Unable to persist corrected recommendations.', error);
    }
  }
}
