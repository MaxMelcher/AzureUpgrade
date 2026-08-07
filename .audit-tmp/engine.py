import json, csv, sys
from datetime import datetime, timezone

CATALOG_PATH = r"G:\Git\AzureUpgrade\src\assets\data\regions\uksouth.json"
RETIRE_PATH = r"G:\Git\AzureUpgrade\src\assets\data\retirements.json"
CSV_PATH = r"G:\Git\AzureUpgrade\.audit-tmp\recs.csv"

catalog = json.load(open(CATALOG_PATH, encoding='utf-8'))
retirements = json.load(open(RETIRE_PATH, encoding='utf-8'))

families = {k.lower(): v for k, v in retirements['families'].items()}
sku_retire = {k.lower(): v for k, v in retirements['skus'].items()}

def resolve_retirement(name, family, region):
    r = sku_retire.get(name.lower()) or families.get(family.lower())
    if not r:
        return None
    regional = (r.get('regionEolDates') or {}).get(region.lower())
    if regional:
        r = {**r, 'eolDate': regional}
    return r

skus = []
for s in catalog['skus']:
    s = dict(s)
    s['retirement'] = resolve_retirement(s['name'], s['family'], catalog['region'])
    skus.append(s)

lookup = {s['name'].lower(): s for s in skus}

CPU_POLICIES = ['same-vendor', 'prefer-same-vendor', 'any-compatible']

def price_for(vm, os):
    p = vm['prices']['linuxPaygHourly'] if os == 'linux' else vm['prices']['windowsPaygHourly']
    return p if (p is not None and p > 0) else None

def at_least(cand, src):
    return src is None or (cand is not None and cand >= src)

def is_constrained(vm):
    return vm['vcpus'] is not None and vm['vcpusAvailable'] is not None and vm['vcpusAvailable'] < vm['vcpus']

def is_retired(vm):
    r = vm.get('retirement')
    if not r:
        return False
    try:
        eol = datetime.fromisoformat(r['eolDate'] + 'T23:59:59+00:00')
    except Exception:
        return False
    return eol < datetime.now(timezone.utc)

def missing_critical(vm):
    missing = []
    if vm['vcpusAvailable'] is None: missing.append('usable vCPU')
    if vm['memoryGB'] is None: missing.append('memory')
    if vm['maxDataDisks'] is None: missing.append('data disk limit')
    if vm['tempDiskMB'] is None: missing.append('temporary disk')
    if vm['architecture'] is None: missing.append('architecture')
    return missing

def rejection_reason(source, candidate, os, cpu_policy):
    if candidate['name'] == source['name']: return 'sourceSku'
    if candidate['retirement'] is not None: return 'retirement'
    if price_for(candidate, os) is None: return 'price'
    if not at_least(candidate['vcpusAvailable'], source['vcpusAvailable']): return 'usableVcpus'
    if not is_constrained(source) and is_constrained(candidate): return 'constrainedShape'
    if (source['gpus'] or 0) > 0 and not at_least(candidate['gpus'], source['gpus']): return 'gpus'
    if not at_least(candidate['memoryGB'], source['memoryGB']): return 'memory'
    if os == 'windows' and ((source['tempDiskMB'] or 0) > 0) != ((candidate['tempDiskMB'] or 0) > 0): return 'tempDisk'
    if source['premiumIO'] is True and candidate['premiumIO'] is not True: return 'premiumIO'
    if source['acceleratedNetworking'] is True and candidate['acceleratedNetworking'] is not True: return 'acceleratedNetworking'
    if source['rdma'] is True and candidate['rdma'] is not True: return 'rdma'
    if source['architecture'] and candidate['architecture'] != source['architecture']: return 'architecture'
    if cpu_policy == 'same-vendor' and source['cpuVendor'] and candidate['cpuVendor'] != source['cpuVendor']: return 'cpuVendor'
    if (source['cpuVendor'] is not None and source['cpuVendor'] == candidate['cpuVendor'] and
        source['cpuGeneration'] is not None and candidate['cpuGeneration'] is not None and
        candidate['cpuGeneration'] < source['cpuGeneration']):
        return 'olderGeneration'
    return None

def score(source, candidate, source_price, candidate_price, cpu_policy):
    s = 1000.0
    usable_cpu_delta = candidate['vcpusAvailable'] - source['vcpusAvailable']
    memory_delta = candidate['memoryGB'] - source['memoryGB']
    physical_cpu_delta = abs((candidate['vcpus'] if candidate['vcpus'] is not None else candidate['vcpusAvailable']) - (source['vcpus'] if source['vcpus'] is not None else source['vcpusAvailable']))

    s += 350 if usable_cpu_delta == 0 else -usable_cpu_delta * 90
    s += 300 if memory_delta == 0 else -memory_delta * 18
    s -= physical_cpu_delta * 12
    s += 120 if is_constrained(source) == is_constrained(candidate) else -120

    if source['maxDataDisks'] is not None and candidate['maxDataDisks'] is not None and candidate['maxDataDisks'] < source['maxDataDisks']:
        s -= (source['maxDataDisks'] - candidate['maxDataDisks']) * 25

    if source['cpuVendor'] and candidate['cpuVendor'] == source['cpuVendor']:
        s += 260 if cpu_policy == 'prefer-same-vendor' else 140
    elif cpu_policy == 'prefer-same-vendor' and source['cpuVendor']:
        s -= 180

    if (source['cpuVendor'] and source['cpuVendor'] == candidate['cpuVendor'] and
        source['cpuGeneration'] is not None and candidate['cpuGeneration'] is not None):
        generation_delta = candidate['cpuGeneration'] - source['cpuGeneration']
        s += (320 + min(generation_delta, 3) * 25) if generation_delta > 0 else 40
    else:
        s -= 60

    if (source['tempDiskMB'] or 0) > 0 and (candidate['tempDiskMB'] or 0) > 0:
        s += 90 if candidate['tempDiskMB'] == source['tempDiskMB'] else 40

    if source_price is not None and source_price > 0:
        price_ratio = candidate_price / source_price
        if price_ratio <= 1:
            s += min(300, (1 - price_ratio) * 400)
        else:
            import math
            s -= min(1000, math.log2(price_ratio) * 250)
    return round(s * 100) / 100

def is_material_upgrade(source, candidate, source_price, candidate_price):
    if source_price is not None and candidate_price < source_price * 0.99:
        return True
    return (source['cpuVendor'] is not None and source['cpuVendor'] == candidate['cpuVendor'] and
            source['cpuGeneration'] is not None and candidate['cpuGeneration'] is not None and
            candidate['cpuGeneration'] > source['cpuGeneration'])


def find_recommendations(source_name, region, os, cpu_policy):
    source = lookup.get(source_name.lower())
    if not source:
        return None
    source_price = price_for(source, os)
    mandatory = is_retired(source)
    if missing_critical(source):
        return {'status': 'incomplete-capabilities', 'source': source, 'candidates': [], 'mandatory': mandatory}

    candidates = []
    rejected_counts = {}
    for candidate in skus:
        r = rejection_reason(source, candidate, os, cpu_policy)
        if r:
            rejected_counts[r] = rejected_counts.get(r, 0) + 1
            continue
        hourly = price_for(candidate, os)
        monthly_saving = None if source_price is None else (source_price - hourly) * 730
        saving_percent = ((source_price - hourly) / source_price * 100) if (source_price is not None and source_price > 0) else None
        candidates.append({
            'vm': candidate,
            'score': score(source, candidate, source_price, hourly, cpu_policy),
            'hourlyPrice': hourly,
            'monthlySaving': monthly_saving,
            'savingPercent': saving_percent,
        })

    candidates.sort(key=lambda c: (-c['score'], c['hourlyPrice'], c['vm']['name']))
    top = candidates[0] if candidates else None
    no_upgrade_needed = False
    if top and source.get('retirement') is None:
        if not is_material_upgrade(source, top['vm'], source_price, top['hourlyPrice']):
            no_upgrade_needed = True
    return {
        'status': ('no-upgrade-needed' if no_upgrade_needed else ('recommended' if source_price is not None else 'source-price-missing')) if top else 'no-compatible-replacement',
        'source': source,
        'candidates': candidates,
        'mandatory': mandatory,
        'rejected_counts': rejected_counts,
        'no_upgrade_needed': no_upgrade_needed,
    }

def quality_representative_skus():
    fam_map = {}
    for s in skus:
        key = s['family'] or s['name']
        fam_map.setdefault(key, []).append(s)
    reps = []
    for key, members in fam_map.items():
        members_sorted = sorted(members, key=lambda m: (
            int(is_constrained(m)),
            int(price_for(m, 'linux') is None),
            m['vcpusAvailable'] if m['vcpusAvailable'] is not None else 10**9,
            m['memoryGB'] if m['memoryGB'] is not None else 10**9,
            m['name']
        ))
        reps.append(members_sorted[0])
    reps.sort(key=lambda m: m['family'])
    return reps

def explain(source, candidate, source_price, candidate_price):
    reasons = []
    if candidate['vcpusAvailable'] == source['vcpusAvailable'] and candidate['memoryGB'] == source['memoryGB']:
        reasons.append('same usable CPU and memory')
    else:
        reasons.append('required usable CPU and memory preserved')
    if source['cpuVendor'] and candidate['cpuVendor'] == source['cpuVendor']:
        reasons.append(f"{source['cpuVendor']}/{source['architecture'] or 'compatible architecture'} preserved")
    else:
        reasons.append(f"{source['architecture'] or 'architecture'} compatibility preserved")
    if (source['tempDiskMB'] or 0) > 0 and (candidate['tempDiskMB'] or 0) > 0:
        reasons.append('local temporary storage retained')
    elif (source['tempDiskMB'] or 0) > 0:
        reasons.append('Linux supports resizing to a VM without local temporary storage')
    if source['premiumIO']: reasons.append('Premium SSD supported')
    if source['maxDataDisks'] is not None and candidate['maxDataDisks'] is not None and candidate['maxDataDisks'] < source['maxDataDisks']:
        reasons.append(f"reduced data disk limit ({candidate['maxDataDisks']} vs {source['maxDataDisks']}) must be validated")
    if source['cpuGeneration'] is not None and candidate['cpuGeneration'] is not None and candidate['cpuGeneration'] > source['cpuGeneration']:
        reasons.append('newer CPU generation')
    if source_price is None:
        reasons.append('candidate has a usable regional PAYG price, but the source PAYG price is unavailable')
    else:
        saving_percent = (source_price - candidate_price) / source_price * 100
        reasons.append(f"{saving_percent:.1f}% lower PAYG price" if saving_percent >= 0 else f"{abs(saving_percent):.1f}% higher PAYG price")
    def sentence_list(vals):
        if len(vals) < 2: return vals[0] if vals else ''
        return ', '.join(vals[:-1]) + ' and ' + vals[-1]
    explanation = sentence_list(reasons) + '.'
    if is_retired(source):
        return f"This VM retired on {source['retirement']['eolDate']}; upgrading is required. {explanation}"
    return explanation

def confidence_for(source, candidate):
    if missing_critical(source): return 'Low'
    if not source['cpuVendor'] or source['cpuGeneration'] is None or candidate is None or not candidate['cpuVendor'] or candidate['cpuGeneration'] is None:
        return 'Medium'
    if (candidate['vcpusAvailable'] == source['vcpusAvailable'] and candidate['memoryGB'] == source['memoryGB'] and
        (source['maxDataDisks'] is None or candidate['maxDataDisks'] is None or candidate['maxDataDisks'] >= source['maxDataDisks'])):
        return 'High'
    return 'Medium'

def create_quality_matrix(os_list=('linux',)):
    reps = quality_representative_skus()
    rows = []
    for sku in reps:
        for os in os_list:
            for cpu_policy in CPU_POLICIES:
                result = find_recommendations(sku['name'], catalog['region'], os, cpu_policy)
                if result is None:
                    continue
                top = result['candidates'][0] if result['candidates'] else None
                rows.append({
                    'region': catalog['region'],
                    'family': sku['family'],
                    'sourceSku': sku['name'],
                    'os': os,
                    'cpuPolicy': cpu_policy,
                    'status': result['status'] if top else ('no-compatible-replacement' if result['status']=='recommended' else result['status']),
                    'recommendation': top['vm']['name'] if top else '',
                    'sourceHourly': price_for(sku, os),
                    'recommendedHourly': top['hourlyPrice'] if top else None,
                    'monthlySaving': top['monthlySaving'] if top else None,
                    'savingPercent': top['savingPercent'] if top else None,
                    'confidence': confidence_for(result['source'], top['vm'] if top else None),
                    'explanation': explain(result['source'], top['vm'], price_for(sku, os), top['hourlyPrice']) if top else 'No compatible replacement with a usable regional price was found.',
                    'mandatoryUpgrade': result['mandatory'],
                    'sourceEolDate': (sku.get('retirement') or {}).get('eolDate', ''),
                    'candidates': result['candidates'],
                })
    return rows

def collapse(rows):
    collapsed = {}
    order = []
    for row in rows:
        key = json.dumps([row['family'], row['status'], row['recommendation'], row['recommendedHourly'], row['monthlySaving'], row['confidence'], row['mandatoryUpgrade'], row['sourceEolDate']])
        if key in collapsed:
            collapsed[key]['cpuPolicy'] = collapsed[key]['cpuPolicy'] + ' | ' + row['cpuPolicy']
        else:
            collapsed[key] = dict(row)
            order.append(key)
    return [collapsed[k] for k in order]

if __name__ == '__main__':
    reps = quality_representative_skus()
    print('representative count', len(reps))
