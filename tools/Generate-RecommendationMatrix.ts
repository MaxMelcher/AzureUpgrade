import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { QualityMatrixRow, RegionalCatalog } from '../src/app/models/vm.models';
import { RecommendationEngine } from '../src/app/services/recommendation-engine';
import { applyRetirementMetadata } from '../src/app/services/retirement-metadata';

const root = resolve(__dirname, '..', '..');
const region = process.argv[2] ?? 'uksouth';
const inputPath = resolve(root, 'src/assets/data/regions', `${region}.json`);
const outputPath = resolve(
  root,
  process.argv[3] ?? 'quality-check/recommendations-uksouth-linux-family.csv',
);
const rawCatalog = JSON.parse(readFileSync(inputPath, 'utf8')) as RegionalCatalog;
const retirements = JSON.parse(
  readFileSync(resolve(root, 'src/assets/data/retirements.json'), 'utf8'),
);
const catalog = applyRetirementMetadata(rawCatalog, retirements);
const rows: QualityMatrixRow[] = new RecommendationEngine(catalog).createQualityMatrix(['linux']);
console.log(`${region}: ${rows.length.toLocaleString()} Linux combinations`);

const header = [
  'Region',
  'Family',
  'Source VM',
  'OS',
  'CPU policy',
  'Status',
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
];
const csvRows = [
  header,
  ...rows.map((row) => [
    row.region,
    row.family,
    row.sourceSku,
    row.os,
    row.cpuPolicy,
    row.status,
    row.mandatoryUpgrade ? 'Yes' : 'No',
    row.sourceEolDate,
    row.recommendation,
    number(row.sourceHourly),
    number(row.recommendedHourly),
    number(row.monthlySaving),
    number(row.savingPercent),
    catalog.currencyCode,
    row.confidence,
    row.explanation,
  ]),
];

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `\uFEFFsep=,\r\n${csvRows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`,
  'utf8',
);
console.log(`Wrote ${rows.length.toLocaleString()} combinations to ${outputPath}`);

function number(value: number | null): string {
  return value === null ? '' : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
