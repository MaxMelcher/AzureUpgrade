import csv, json
from engine import (lookup, price_for, is_constrained, is_retired, missing_critical,
                     rejection_reason, score, find_recommendations, skus, catalog)

with open(r'G:\Git\AzureUpgrade\.audit-tmp\recs.csv', encoding='utf-8-sig') as f:
    lines = f.readlines()
reader = csv.reader(lines[1:])
header = next(reader)
csv_rows = list(reader)

def num(x):
    try:
        return float(x)
    except Exception:
        return None

out = []
for i, r in enumerate(csv_rows):
    family, src_name, os_, cpu_policy_field, status, mandatory, eol, rec_name = r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]
    src_hourly, rec_hourly, monthly_saving, saving_pct = num(r[9]), num(r[10]), num(r[11]), num(r[12])
    confidence, explanation = r[14], r[15]
    policies = [p.strip() for p in cpu_policy_field.split('|')]

    src = lookup.get(src_name.lower())
    if not src:
        continue

    entry = {'row': i+2, 'family': family, 'src': src_name, 'csv_rec': rec_name, 'csv_status': status,
              'csv_saving_pct': saving_pct, 'policies': policies, 'per_policy': []}

    for pol in policies:
        result = find_recommendations(src_name, catalog['region'], os_, pol)
        if result is None:
            continue
        cands = result['candidates']
        top = cands[0] if cands else None
        # find rank of csv_rec among candidates (valid ones)
        rank = None
        rec_score = None
        rec_reject = rejection_reason(src, lookup.get(rec_name.lower()), os_, pol) if rec_name and lookup.get(rec_name.lower()) else 'NOT_FOUND'
        for idx, c in enumerate(cands):
            if c['vm']['name'].lower() == rec_name.lower():
                rank = idx + 1
                rec_score = c['score']
                break
        entry['per_policy'].append({
            'policy': pol,
            'status': result['status'],
            'top_name': top['vm']['name'] if top else None,
            'top_score': top['score'] if top else None,
            'top_price': top['hourlyPrice'] if top else None,
            'top_vendor': top['vm']['cpuVendor'] if top else None,
            'csv_rec_rank': rank,
            'csv_rec_score': rec_score,
            'csv_rec_reject_reason': rec_reject,
            'num_candidates': len(cands),
        })
    out.append(entry)

with open('detailed.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1)

# Print a compact summary: rows where CSV rec is not rank 1 for ANY listed policy, or rejected
print('Rows where CSV recommendation is NOT top-ranked (or rejected) under at least one listed policy:')
count = 0
for e in out:
    problems = []
    for pp in e['per_policy']:
        if pp['csv_rec_reject_reason'] not in (None,):
            problems.append(f"[{pp['policy']}] REJECTED:{pp['csv_rec_reject_reason']} (current top={pp['top_name']} score={pp['top_score']} price={pp['top_price']})")
        elif pp['csv_rec_rank'] is not None and pp['csv_rec_rank'] != 1:
            problems.append(f"[{pp['policy']}] rank={pp['csv_rec_rank']} of {pp['num_candidates']} (top={pp['top_name']} score={pp['top_score']} vs csv_rec_score={pp['csv_rec_score']})")
    if problems:
        count += 1
        print(f"ROW {e['row']}: family={e['family']} src={e['src']} csv_rec={e['csv_rec']}")
        for p in problems:
            print('   ', p)
print('TOTAL problem rows:', count)
