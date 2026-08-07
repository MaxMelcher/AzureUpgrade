import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of, shareReplay, tap } from 'rxjs';
import {
  RegionInfo,
  RegionalCatalog,
  RetirementCatalog,
  WorkloadCatalog,
  CurrencyCode,
} from '../models/vm.models';
import { applyRetirementMetadata } from './retirement-metadata';
import { applyWorkloadMetadata } from './workload-metadata';

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly http = inject(HttpClient);
  private readonly regionCache = new Map<string, RegionalCatalog>();
  private readonly retirementMetadata = this.http
    .get<RetirementCatalog>('assets/data/retirements.json')
    .pipe(shareReplay(1));
  private readonly workloadMetadata = this.http
    .get<WorkloadCatalog>('assets/data/workload-families.json')
    .pipe(shareReplay(1));

  public loadRegions(): Observable<RegionInfo[]> {
    return this.http.get<RegionInfo[]>('assets/data/regions.json').pipe(shareReplay(1));
  }

  public loadRegion(region: string, currency: CurrencyCode): Observable<RegionalCatalog> {
    const normalized = region.toLowerCase();
    const normalizedCurrency = currency.toLowerCase();
    const cacheKey = `${normalizedCurrency}/${normalized}`;
    const cached = this.regionCache.get(cacheKey);
    if (cached) {
      return of(cached);
    }

    return forkJoin({
      catalog: this.http.get<RegionalCatalog>(
        `assets/data/regions/${normalizedCurrency}/${normalized}.json`,
      ),
      retirements: this.retirementMetadata,
      workloads: this.workloadMetadata,
    }).pipe(
      map(({ catalog, retirements, workloads }) =>
        applyWorkloadMetadata(applyRetirementMetadata(catalog, retirements), workloads),
      ),
      tap((catalog) => this.regionCache.set(cacheKey, catalog)),
      shareReplay(1),
    );
  }
}
