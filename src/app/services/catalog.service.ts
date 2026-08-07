import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of, shareReplay, tap } from 'rxjs';
import {
  RegionInfo,
  RegionalCatalog,
  RetirementCatalog,
  WorkloadCatalog,
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

  public loadRegion(region: string): Observable<RegionalCatalog> {
    const normalized = region.toLowerCase();
    const cached = this.regionCache.get(normalized);
    if (cached) {
      return of(cached);
    }

    return forkJoin({
      catalog: this.http.get<RegionalCatalog>(`assets/data/regions/${normalized}.json`),
      retirements: this.retirementMetadata,
      workloads: this.workloadMetadata,
    }).pipe(
      map(({ catalog, retirements, workloads }) =>
        applyWorkloadMetadata(applyRetirementMetadata(catalog, retirements), workloads),
      ),
      tap((catalog) => this.regionCache.set(normalized, catalog)),
      shareReplay(1),
    );
  }
}
