import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { AdvisorFormComponent, AdvisorRequest } from './components/advisor-form/advisor-form';
import { ResultsListComponent } from './components/results-list/results-list';
import { RegionInfo, RecommendationResult } from './models/vm.models';
import { CatalogService } from './services/catalog.service';
import { ExportService } from './services/export.service';
import { RecommendationEngine } from './services/recommendation-engine';

@Component({
  selector: 'app-root',
  imports: [AdvisorFormComponent, ResultsListComponent],
  template: `
    <header class="app-header">
      <div class="shell header-content">
        <a class="brand" href="/" aria-label="Azure VM Upgrade Advisor home">
          <span class="brand-mark" aria-hidden="true">A</span>
          <span>Azure VM Upgrade Advisor</span>
        </a>
        <a class="docs-link" href="https://azure.microsoft.com/pricing/details/virtual-machines/"
          target="_blank" rel="noreferrer">Azure retail pricing</a>
      </div>
    </header>

    <main class="shell">
      <section class="hero">
        <p class="eyebrow">Modernize with confidence</p>
        <h1>Find a compatible, modern Azure VM</h1>
        <p class="hero-copy">
          Compare regional availability, authoritative Azure SKU capabilities, and retail prices
          without sending your VM inventory to a backend.
        </p>
      </section>

      @if (regionsError()) {
        <div class="notice error" role="alert">{{ regionsError() }}</div>
      }

      <app-advisor-form
        [regions]="regions()"
        [busy]="busy()"
        (findUpgrades)="findUpgrades($event)"
      />

      @if (searchError()) {
        <div class="notice error" role="alert">{{ searchError() }}</div>
      }

      @if (results().length > 0) {
        <app-results-list
          [results]="results()"
          [regionName]="selectedRegionName()"
          [currencyCode]="currencyCode()"
          [busyMatrix]="busyMatrix()"
          (copyResults)="copyResults()"
          (downloadCsv)="downloadResults()"
          (downloadMatrix)="downloadQualityMatrix()"
        />
      }
    </main>

    <footer class="shell">
      Estimates use continuous runtime (730 hours/month, 8,760 hours/year) and public Azure retail pricing.
      Subscription offers, negotiated discounts, quotas, and reservations may differ.
    </footer>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit {
  private readonly catalogService = inject(CatalogService);
  private readonly exportService = inject(ExportService);

  protected readonly regions = signal<RegionInfo[]>([]);
  protected readonly results = signal<RecommendationResult[]>([]);
  protected readonly regionsError = signal('');
  protected readonly searchError = signal('');
  protected readonly busy = signal(false);
  protected readonly busyMatrix = signal(false);
  protected readonly selectedRegionName = signal('');
  protected readonly currencyCode = signal('GBP');
  private lastRequest: AdvisorRequest | null = null;
  private engine: RecommendationEngine | null = null;

  public ngOnInit(): void {
    this.catalogService.loadRegions().subscribe({
      next: (regions) => this.regions.set(regions),
      error: () => this.regionsError.set(
        'The regional catalog could not be loaded. Generate it with tools/Generate-VmCatalog.ps1.'
      )
    });
  }

  protected findUpgrades(request: AdvisorRequest): void {
    this.busy.set(true);
    this.searchError.set('');
    this.results.set([]);
    this.lastRequest = request;

    this.catalogService.loadRegion(request.region).subscribe({
      next: (catalog) => {
        this.engine = new RecommendationEngine(catalog);
        this.selectedRegionName.set(catalog.displayName);
        this.currencyCode.set(catalog.currencyCode);
        this.results.set(request.skus.map((sku) =>
          this.engine!.findRecommendations(sku, request.region, request.os, request.cpuPolicy)
        ));
        this.busy.set(false);
      },
      error: () => {
        this.searchError.set('No generated catalog is available for this region.');
        this.busy.set(false);
      }
    });
  }

  protected async copyResults(): Promise<void> {
    await this.exportService.copyResults(this.results(), this.currencyCode());
  }

  protected downloadResults(): void {
    this.exportService.downloadResults(
      this.results(),
      this.currencyCode(),
      `azure-vm-upgrades-${this.lastRequest?.region ?? 'results'}.csv`
    );
  }

  protected downloadQualityMatrix(): void {
    if (!this.engine || !this.lastRequest) {
      return;
    }

    this.busyMatrix.set(true);
    window.setTimeout(() => {
      const rows = this.engine!.createQualityMatrix();
      this.exportService.downloadQualityMatrix(
        rows,
        this.currencyCode(),
        `recommendation-quality-matrix-${this.lastRequest!.region}.csv`
      );
      this.busyMatrix.set(false);
    });
  }
}
