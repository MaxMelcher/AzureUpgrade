import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RegionalCatalog } from '../src/app/models/vm.models';
import {
  RecommendationEngine,
  representativeSkus,
} from '../src/app/services/recommendation-engine';
import { applyCpuMetadata } from '../src/app/services/cpu-metadata';
import {
  applyLifecycleStatus,
  applyRetirementMetadata,
} from '../src/app/services/retirement-metadata';
import { applyWorkloadMetadata } from '../src/app/services/workload-metadata';

const root = resolve(__dirname, '..', '..');
const region = process.argv[2] ?? 'uksouth';
const currency = (process.argv[4] ?? 'GBP').toLowerCase();
const inputPath = resolve(root, 'src/assets/data/regions', currency, `${region}.json`);
const outputPath = resolve(
  root,
  process.argv[3] ?? 'quality-check/recommendations-uksouth-linux-family.csv',
);
const rawCatalog = JSON.parse(readFileSync(inputPath, 'utf8')) as RegionalCatalog;
const retirements = JSON.parse(
  readFileSync(resolve(root, 'src/assets/data/retirements.json'), 'utf8'),
);
const workloads = JSON.parse(
  readFileSync(resolve(root, 'src/assets/data/workload-families.json'), 'utf8'),
);
const cpus = JSON.parse(readFileSync(resolve(root, 'src/assets/data/cpu-families.json'), 'utf8'));
const catalog = applyLifecycleStatus(
  applyRetirementMetadata(
    applyWorkloadMetadata(applyCpuMetadata(rawCatalog, cpus), workloads),
    retirements,
  ),
);
const engine = new RecommendationEngine(catalog);
const representatives = representativeSkus(catalog, 'linux');
const rows = representatives.map((source) => ({
  source,
  recommendation: engine.recommend(source.name, 'linux'),
}));
console.log(`${region}: ${rows.length.toLocaleString()} Linux family representatives`);

const header = [
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
];
const csvRows = [
  header,
  ...rows.map(({ source, recommendation }) => [
    catalog.region,
    source.family,
    source.name,
    'linux',
    recommendation.outcome,
    source.lifecycleStatus,
    source.retirement?.eolDate ?? '',
    recommendation.outcome === 'source-not-found' ||
    recommendation.outcome === 'no-compatible-replacement'
      ? ''
      : recommendation.targetVm,
    number(recommendation.sourceHourlyPrice),
    number(recommendation.targetHourlyPrice),
    number(
      recommendation.sourceHourlyPrice !== null && recommendation.targetHourlyPrice !== null
        ? (recommendation.sourceHourlyPrice - recommendation.targetHourlyPrice) * 730
        : null,
    ),
    number(recommendation.savingPercent),
    String(recommendation.candidateCount),
    catalog.currencyCode,
    recommendation.reason,
  ]),
];

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `\uFEFFsep=,\n${csvRows.map((row) => row.map(escapeCsv).join(',')).join('\n')}`,
  'utf8',
);
console.log(`Wrote ${rows.length.toLocaleString()} representatives to ${outputPath}`);

function number(value: number | null): string {
  return value === null ? '' : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
