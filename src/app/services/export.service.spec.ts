import { afterEach, describe, expect, it, vi } from 'vitest';

import { Recommendation } from './recommendation-engine';
import { ExportService } from './export.service';

describe('ExportService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('includes hourly, monthly and yearly prices in the results CSV', async () => {
    let downloadedBlob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) downloadedBlob = blob;
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const recommendation: Recommendation = {
      sourceVm: 'Standard_D2s_v3',
      targetVm: 'Standard_D2s_v5',
      outcome: 'cost-optimization',
      reason: 'Cost optimization',
      sourceHourlyPrice: 0.0879,
      targetHourlyPrice: 0.0841,
      savingPercent: 4.3230944255,
      candidateCount: 1,
      compatibleCandidates: ['Standard_D2s_v5'],
      migrationGuideUrl: null,
    };

    new ExportService().downloadResults([recommendation], 'GBP', 'recommendations.csv');

    expect(downloadedBlob).not.toBeNull();
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsText(downloadedBlob!);
    });
    expect(csv).toContain(
      '"Current hourly","New hourly","Current monthly","New monthly","Current yearly","New yearly"',
    );
    expect(csv).toContain('"0.0879","0.0841","64.167","61.393","770.004","736.716"');
  });
});
