import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, of, shareReplay, tap } from 'rxjs';
import { RegionInfo, RegionalCatalog } from '../models/vm.models';

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly http = inject(HttpClient);
  private readonly regionCache = new Map<string, RegionalCatalog>();

  public loadRegions(): Observable<RegionInfo[]> {
    return this.http.get<RegionInfo[]>('assets/data/regions.json').pipe(shareReplay(1));
  }

  public loadRegion(region: string): Observable<RegionalCatalog> {
    const normalized = region.toLowerCase();
    const cached = this.regionCache.get(normalized);
    if (cached) {
      return of(cached);
    }

    return this.http.get<RegionalCatalog>(`assets/data/regions/${normalized}.json`).pipe(
      tap((catalog) => this.regionCache.set(normalized, catalog)),
      shareReplay(1)
    );
  }
}
