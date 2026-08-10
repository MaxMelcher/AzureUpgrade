import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { QualityMatrixRow, RegionalCatalog } from '../src/app/models/vm.models';
import { RecommendationEngine } from '../src/app/services/recommendation-engine';
import {
  SimpleRecommendation,
  SimpleRecommendationEngine,
} from '../src/app/services/simple-recommendation-engine';
import { applyCpuMetadata } from '../src/app/services/cpu-metadata';
import {
  applyLifecycleStatus,
  applyRetirementMetadata,
} from '../src/app/services/retirement-metadata';
import { applyWorkloadMetadata } from '../src/app/services/workload-metadata';

/**
 * Runs the current `RecommendationEngine` and the simplified `SimpleRecommendationEngine` over the
 * same catalog and writes a side-by-side comparison CSV plus a console summary.
 */
const root = resolve(__dirname, '..', '..');
const region = process.argv[2] ?? 'uksouth';
const currency = (process.argv[4] ?? 'GBP').toLowerCase();
const inputPath = resolve(root, 'src/assets/data/regions', currency, `${region}.json`);
const outputPath = resolve(
  root,
  process.argv[3] ?? `quality-check/engine-comparison-${region}-linux.csv`,
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

const current = new RecommendationEngine(catalog);
const simple = new SimpleRecommendationEngine(catalog);
const currentRows: QualityMatrixRow[] = current.createQualityMatrix(['linux']);

interface ComparisonRow {
  row: QualityMatrixRow;
  simple: SimpleRecommendation;
  agrees: boolean;
}

const comparisons: ComparisonRow[] = currentRows.map((row) => {
  const simpleResult = simple.recommend(row.sourceSku, row.os);
  const currentTarget = row.recommendation || row.sourceSku;
  const simpleTarget =
    simpleResult.outcome === 'no-compatible-replacement' ? '' : simpleResult.targetVm;
  return {
    row,
    simple: simpleResult,
    agrees: currentTarget.toLowerCase() === (simpleTarget || row.sourceSku).toLowerCase(),
  };
});

const header = [
  'Region',
  'Family',
  'Source VM',
  'OS',
  'Lifecycle',
  'Current recommendation',
  'Current type',
  'Simple recommendation',
  'Simple outcome',
  'Same target',
  'Source hourly',
  'Current hourly',
  'Simple hourly',
  'Currency',
  'Simple reason',
];
const csvRows = [
  header,
  ...comparisons.map(({ row, simple: simpleResult, agrees }) => [
    row.region,
    row.family,
    row.sourceSku,
    row.os,
    row.sourceLifecycleStatus,
    row.recommendation,
    row.recommendationType,
    simpleResult.outcome === 'no-compatible-replacement' ? '' : simpleResult.targetVm,
    simpleResult.outcome,
    agrees ? 'Yes' : 'No',
    number(row.sourceHourly),
    number(row.recommendedHourly),
    number(simpleResult.targetHourlyPrice),
    catalog.currencyCode,
    simpleResult.reason,
  ]),
];

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `\uFEFFsep=,\n${csvRows.map((row) => row.map(escapeCsv).join(',')).join('\n')}`,
  'utf8',
);

const agreed = comparisons.filter((entry) => entry.agrees).length;
const outcomes = new Map<string, number>();
for (const entry of comparisons) {
  const key = `${entry.row.recommendationType} → ${entry.simple.outcome}`;
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}

console.log(`${region}: compared ${comparisons.length.toLocaleString()} family representatives`);
console.log(
  `Same target: ${agreed.toLocaleString()} (${((agreed / comparisons.length) * 100).toFixed(1)}%)`,
);
console.log('Current type → simple outcome:');
for (const [key, count] of [...outcomes.entries()].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${count.toString().padStart(4)}  ${key}`);
}
console.log(`Wrote ${comparisons.length.toLocaleString()} comparisons to ${outputPath}`);

function number(value: number | null): string {
  return value === null ? '' : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
