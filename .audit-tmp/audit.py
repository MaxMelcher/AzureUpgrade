import csv, json
from engine import (lookup, price_for, is_constrained, is_retired, missing_critical,
                     rejection_reason, score, find_recommendations, skus, catalog)

with open(r'G:\Git\AzureUpgrade\.audit-tmp\recs.csv', encoding='utf-8-sig') as f:
    lines = f.readlines()
reader = csv.reader(lines[1:])
header = next(reader)
csv_rows = list(reader)

# columns: 0 Region,1 Family,2 Source VM,3 OS,4 CPU policy,5 Status,6 Mandatory upgrade,7 EOL date,
# 8 Recommended VM,9 Source hourly,10 Recommended hourly,11 Monthly saving,12 Saving %,13 Currency,14 Confidence,15 Explanation

def num(x):
    try:
        return float(x)
    except Exception:
        return None

findings = []

for i, r in enumerate(csv_rows):
    family, src_name, os_, cpu_policy_field, status, mandatory, eol, rec_name = r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]
    src_hourly, rec_hourly, monthly_saving, saving_pct = num(r[9]), num(r[10]), num(r[11]), num(r[12])
    confidence, explanation = r[14], r[15]

    src = lookup.get(src_name.lower())
    if not src:
        findings.append({'row': i, 'src': src_name, 'issue': 'SOURCE_NOT_FOUND'})
        continue

    row_flags = []

    # Use the FIRST listed policy from the collapsed field as representative for hard-constraint validation
    policies = [p.strip() for p in cpu_policy_field.split('|')]
    primary_policy = policies[0]

    if status != 'recommended':
        # still worth recording no-rec / price-missing rows for completeness
        findings.append({'row': i, 'family': family, 'src': src_name, 'status': status, 'issue': None, 'policies': policies})
        continue

    rec = lookup.get(rec_name.lower())
    if not rec:
        row_flags.append('RECOMMENDATION_NOT_FOUND_IN_CATALOG')
        rec = None

    if rec:
        # Validate hard constraints for EACH listed policy (since collapsed outcome implies same result across those policies)
        for pol in policies:
            reason = rejection_reason(src, rec, os_, pol)
            if reason:
                row_flags.append(f'HARD_CONSTRAINT_VIOLATION[{pol}]:{reason}')

        # retirement of recommended target
        if rec.get('retirement'):
            row_flags.append(f"RECOMMENDS_RETIRING_SKU(eol={rec['retirement']['eolDate']})")

        # price increase thresholds
        if saving_pct is not None and saving_pct < -20:
            row_flags.append(f'LARGE_PRICE_INCREASE({saving_pct:.1f}%)')

        # vendor swap under prefer-same-vendor / same-vendor
        if src.get('cpuVendor') and rec.get('cpuVendor') != src.get('cpuVendor'):
            if 'same-vendor' in policies or 'prefer-same-vendor' in policies:
                row_flags.append(f"VENDOR_SWAP({src.get('cpuVendor')}->{rec.get('cpuVendor')}) under {policies}")

        # constrained mismatch
        if not is_constrained(src) and is_constrained(rec):
            row_flags.append('NONCONSTRAINED_TO_CONSTRAINED')

        # overprovisioning check
        if src.get('vcpusAvailable') is not None and rec.get('vcpusAvailable') is not None:
            cpu_ratio = rec['vcpusAvailable'] / src['vcpusAvailable'] if src['vcpusAvailable'] else None
            if cpu_ratio and cpu_ratio >= 2:
                row_flags.append(f"CPU_OVERPROVISION(x{cpu_ratio:.1f}: {src['vcpusAvailable']}->{rec['vcpusAvailable']})")
        if src.get('memoryGB') is not None and rec.get('memoryGB') is not None and src['memoryGB'] > 0:
            mem_ratio = rec['memoryGB'] / src['memoryGB']
            if mem_ratio >= 2:
                row_flags.append(f"MEM_OVERPROVISION(x{mem_ratio:.1f}: {src['memoryGB']}->{rec['memoryGB']})")

        # GPU mismatch
        if (src.get('gpus') or 0) > 0 and (rec.get('gpus') or 0) < (src.get('gpus') or 0):
            row_flags.append(f"GPU_REDUCED({src.get('gpus')}->{rec.get('gpus')})")
        if (src.get('gpus') or 0) == 0 and (rec.get('gpus') or 0) > 0:
            row_flags.append(f"GPU_ADDED_UNNECESSARILY(0->{rec.get('gpus')})")

        # RDMA
        if src.get('rdma') and not rec.get('rdma'):
            row_flags.append('RDMA_LOST')

        # temp disk (linux allowed to drop, but flag informationally if huge drop)
        if (src.get('tempDiskMB') or 0) > 0 and (rec.get('tempDiskMB') or 0) == 0:
            row_flags.append('TEMP_DISK_REMOVED(linux-allowed-but-check)')

        # data disks reduced
        if src.get('maxDataDisks') is not None and rec.get('maxDataDisks') is not None and rec['maxDataDisks'] < src['maxDataDisks']:
            row_flags.append(f"DATA_DISKS_REDUCED({src['maxDataDisks']}->{rec['maxDataDisks']})")

        # accelerated networking loss
        if src.get('acceleratedNetworking') and not rec.get('acceleratedNetworking'):
            row_flags.append('ACCELNET_LOST')

    if row_flags:
        findings.append({'row': i, 'family': family, 'src': src_name, 'rec': rec_name, 'policies': policies,
                          'src_hourly': src_hourly, 'rec_hourly': rec_hourly, 'saving_pct': saving_pct,
                          'confidence': confidence, 'flags': row_flags})

print(f'Total rows analyzed: {len(csv_rows)}')
print(f'Rows with flags: {len([f for f in findings if f.get("flags")])}')
print()
for f in findings:
    if f.get('flags'):
        print(f"ROW {f['row']+2}: family={f['family']} src={f['src']} rec={f.get('rec')} policies={f['policies']} saving%={f.get('saving_pct')}")
        for fl in f['flags']:
            print('   -', fl)
        print()
