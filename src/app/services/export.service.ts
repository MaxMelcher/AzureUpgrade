import { Injectable } from '@angular/core';
import { OperatingSystem, RegionalCatalog, VmSku } from '../models/vm.models';
import { Recommendation } from './recommendation-engine';

@Injectable({ providedIn: 'root' })
export class ExportService {
  public async copyResults(results: Recommendation[], currencyCode: string): Promise<void> {
    const rows = [
      [
        'Current VM',
        'Recommended VM',
        'Outcome',
        'Current hourly',
        'New hourly',
        'Monthly saving',
        'Saving %',
        'Compatible candidates',
        'Reason',
      ],
      ...results.map((result) => [
        result.sourceVm,
        this.recommendedVm(result),
        result.outcome,
        this.number(result.sourceHourlyPrice),
        this.number(result.targetHourlyPrice),
        this.number(this.monthlySaving(result)),
        this.number(result.savingPercent),
        String(result.candidateCount),
        result.reason,
      ]),
    ];
    const text = `${rows.map((row) => row.join('\t')).join('\r\n')}\r\nCurrency\t${currencyCode}`;
    await navigator.clipboard.writeText(text);
  }

  public downloadResults(
    results: Recommendation[],
    currencyCode: string,
    fileName: string,
  ): void {
    const rows: Array<Array<string | number | null>> = [
      [
        'Current VM',
        'Recommended VM',
        'Outcome',
        'Current hourly',
        'New hourly',
        'Current yearly',
        'New yearly',
        'Monthly saving',
        'Saving %',
        'Compatible candidates',
        'Currency',
        'Reason',
      ],
    ];

    for (const result of results) {
      rows.push([
        result.sourceVm,
        this.recommendedVm(result),
        result.outcome,
        result.sourceHourlyPrice,
        result.targetHourlyPrice,
        result.sourceHourlyPrice === null ? null : result.sourceHourlyPrice * 8760,
        result.targetHourlyPrice === null ? null : result.targetHourlyPrice * 8760,
        this.monthlySaving(result),
        result.savingPercent,
        result.candidateCount,
        currencyCode,
        result.reason,
      ]);
    }
    this.download(rows, fileName);
  }

  public downloadQualityMatrix(
    results: Recommendation[],
    catalog: RegionalCatalog,
    os: OperatingSystem,
    currencyCode: string,
    fileName: string,
  ): void {
    const lookup = new Map(catalog.skus.map((sku) => [sku.name.toLowerCase(), sku]));
    const rows: Array<Array<string | number | null>> = [
      [
        'Region',
        'Family',
        'Source VM',
        'OS',
        'Outcome',
        'Lifecycle',
        'EOL date',
        'Recommended VM',
        'Source hourly',
        'Recommended hourly',
        'Monthly saving',
        'Saving %',
        'Compatible candidates',
        'Currency',
        'Reason',
      ],
    ];
    for (const result of results) {
      const source = lookup.get(result.sourceVm.toLowerCase()) ?? null;
      rows.push([
        catalog.region,
        source?.family ?? '',
        result.sourceVm,
        os,
        result.outcome,
        source?.lifecycleStatus ?? '',
        source?.retirement?.eolDate ?? '',
        this.recommendedVm(result),
        result.sourceHourlyPrice,
        result.targetHourlyPrice,
        this.monthlySaving(result),
        result.savingPercent,
        result.candidateCount,
        currencyCode,
        result.reason,
      ]);
    }
    this.download(rows, fileName);
  }

  private recommendedVm(result: Recommendation): string {
    return result.outcome === 'source-not-found' || result.outcome === 'no-compatible-replacement'
      ? ''
      : result.targetVm;
  }

  private monthlySaving(result: Recommendation): number | null {
    return result.sourceHourlyPrice !== null && result.targetHourlyPrice !== null
      ? (result.sourceHourlyPrice - result.targetHourlyPrice) * 730
      : null;
  }

  private download(rows: Array<Array<string | number | null>>, fileName: string): void {
    const csv = rows.map((row) => row.map((value) => this.escape(value)).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFFsep=,\r\n${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private escape(value: string | number | null): string {
    if (value === null) return '';
    const text = typeof value === 'number' ? this.number(value) : value;
    return `"${text.replaceAll('"', '""')}"`;
  }

  private number(value: number | null): string {
    return value === null ? '' : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
}
