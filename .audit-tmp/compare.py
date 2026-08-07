import csv
from engine import create_quality_matrix, collapse

rows = create_quality_matrix(['linux'])
collapsed = collapse(rows)
print('generated rows:', len(collapsed))

# Load CSV
with open(r'G:\Git\AzureUpgrade\.audit-tmp\recs.csv', encoding='utf-8-sig') as f:
    lines = f.readlines()
# first line is sep=, ; second is header
reader = csv.reader(lines[1:])
header = next(reader)
csv_rows = list(reader)
print('csv rows:', len(csv_rows))

# Build lookup by (family, sourceSku) -> csv row (there could be dup families? check)
from collections import defaultdict
csv_by_key = defaultdict(list)
for r in csv_rows:
    key = (r[1], r[2])  # Family, Source VM
    csv_by_key[key].append(r)

gen_by_key = defaultdict(list)
for r in collapsed:
    key = (r['family'], r['sourceSku'])
    gen_by_key[key].append(r)

print('unique csv keys', len(csv_by_key), 'unique gen keys', len(gen_by_key))

only_csv = set(csv_by_key) - set(gen_by_key)
only_gen = set(gen_by_key) - set(csv_by_key)
print('keys only in csv:', only_csv)
print('keys only in generated:', only_gen)

mismatches = []
for key in csv_by_key:
    csvrs = csv_by_key[key]
    genrs = gen_by_key[key]
    if len(csvrs) != 1 or len(genrs) != 1:
        mismatches.append((key, 'dup', csvrs, genrs))
        continue
    c = csvrs[0]
    g = genrs[0]
    # CSV columns: Region,Family,SourceVM,OS,CPUpolicy,Status,Mandatory,EOL,RecommendedVM,SourceHourly,RecHourly,MonthlySaving,SavingPct,Currency,Confidence,Explanation
    diffs = []
    if c[5] != g['status']: diffs.append(('status', c[5], g['status']))
    if c[8] != g['recommendation']: diffs.append(('recommendation', c[8], g['recommendation']))
    if c[6] != ('Yes' if g['mandatoryUpgrade'] else 'No'): diffs.append(('mandatory', c[6], g['mandatoryUpgrade']))
    if c[14] != g['confidence']: diffs.append(('confidence', c[14], g['confidence']))
    if c[4].strip() != g['cpuPolicy'].strip(): diffs.append(('cpuPolicy', c[4], g['cpuPolicy']))
    if diffs:
        mismatches.append((key, 'diff', diffs, None))

print('total mismatches:', len(mismatches))
with open('mismatches.txt', 'w', encoding='utf-8') as out:
    for m in mismatches:
        out.write(repr(m) + '\n')


