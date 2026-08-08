import { Injectable } from '@angular/core';
import { QualityMatrixRow, RecommendationResult } from '../models/vm.models';

@Injectable({ providedIn: 'root' })
export class ExportService {
  public async copyResults(results: RecommendationResult[], currencyCode: string): Promise<void> {
    const rows = [
      [
        'Current VM',
        'Recommended VM',
        'Status',
        'Lifecycle',
        'Mandatory upgrade',
        'EOL date',
        'Current hourly',
        'New hourly',
        'Monthly saving',
        'Confidence',
      ],
      ...results.map((result) => [
        result.source?.name ?? result.inputSku,
        result.recommendation?.vm.name ?? '',
        result.status,
        result.source?.lifecycleStatus ?? '',
        result.mandatoryUpgrade ? 'Yes' : 'No',
        result.source?.retirement?.eolDate ?? '',
        this.number(result.source ? this.price(result, result.source) : null),
        this.number(result.recommendation?.hourlyPrice ?? null),
        this.number(result.recommendation?.monthlySaving ?? null),
        result.confidence,
      ]),
    ];
    const text = `${rows.map((row) => row.join('\t')).join('\r\n')}\r\nCurrency\t${currencyCode}`;
    await navigator.clipboard.writeText(text);
  }

  public downloadResults(
    results: RecommendationResult[],
    currencyCode: string,
    fileName: string,
  ): void {
    const rows: Array<Array<string | number | null>> = [
      [
        'Current VM',
        'Recommended VM',
        'Region',
        'OS',
        'Status',
        'Lifecycle',
        'Mandatory upgrade',
        'EOL date',
        'Current vCPU',
        'New vCPU',
        'Current RAM GB',
        'New RAM GB',
        'CPU vendor',
        'CPU architecture',
        'Temp disk MB',
        'Current hourly',
        'New hourly',
        'Current yearly',
        'New yearly',
        'Monthly saving',
        'Saving %',
        'Currency',
        'Confidence',
        'Explanation',
      ],
    ];

    for (const result of results) {
      const sourcePrice = result.source ? this.price(result, result.source) : null;
      rows.push([
        result.source?.name ?? result.inputSku,
        result.recommendation?.vm.name ?? '',
        result.region,
        result.os,
        result.status,
        result.source?.lifecycleStatus ?? '',
        result.mandatoryUpgrade ? 'Yes' : 'No',
        result.source?.retirement?.eolDate ?? '',
        result.source?.vcpusAvailable ?? null,
        result.recommendation?.vm.vcpusAvailable ?? null,
        result.source?.memoryGB ?? null,
        result.recommendation?.vm.memoryGB ?? null,
        result.recommendation?.vm.cpuVendor ?? '',
        result.recommendation?.vm.cpuArchitecture ?? '',
        result.recommendation?.vm.tempDiskMB ?? null,
        sourcePrice,
        result.recommendation?.hourlyPrice ?? null,
        sourcePrice === null ? null : sourcePrice * 8760,
        result.recommendation ? result.recommendation.hourlyPrice * 8760 : null,
        result.recommendation?.monthlySaving ?? null,
        result.recommendation?.savingPercent ?? null,
        currencyCode,
        result.confidence,
        result.explanation,
      ]);
    }
    this.download(rows, fileName);
  }

  public downloadQualityMatrix(
    matrix: QualityMatrixRow[],
    currencyCode: string,
    fileName: string,
  ): void {
    const rows: Array<Array<string | number | null>> = [
      [
        'Region',
        'Family',
        'Source VM',
        'OS',
        'Status',
        'Recommendation state',
        'Lifecycle',
        'Mandatory upgrade',
        'EOL date',
        'Recommended VM',
        'Source hourly',
        'Recommended hourly',
        'Monthly saving',
        'Saving %',
        'Currency',
        'Confidence',
        'Explanation',
      ],
    ];
    for (const row of matrix) {
      rows.push([
        row.region,
        row.family,
        row.sourceSku,
        row.os,
        row.status,
        row.recommendationState,
        row.sourceLifecycleStatus,
        row.mandatoryUpgrade ? 'Yes' : 'No',
        row.sourceEolDate,
        row.recommendation,
        row.sourceHourly,
        row.recommendedHourly,
        row.monthlySaving,
        row.savingPercent,
        currencyCode,
        row.confidence,
        row.explanation,
      ]);
    }
    this.download(rows, fileName);
  }

  private price(
    result: RecommendationResult,
    vm: NonNullable<RecommendationResult['source']>,
  ): number | null {
    return result.os === 'linux' ? vm.prices.linuxPaygHourly : vm.prices.windowsPaygHourly;
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
