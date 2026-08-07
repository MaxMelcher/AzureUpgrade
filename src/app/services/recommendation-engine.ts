import {
  CandidateRecommendation,
  Confidence,
  CpuPolicy,
  OperatingSystem,
  QualityMatrixRow,
  RecommendationResult,
  RejectedCandidateStatistics,
  RegionalCatalog,
  VmSku,
} from '../models/vm.models';

const CPU_POLICIES: CpuPolicy[] = ['same-vendor', 'prefer-same-vendor', 'any-compatible'];
const BURSTABLE_FAMILIES = new Set([
  'standardbsfamily',
  'standardbasv2family',
  'standardbsv2family',
]);

export class RecommendationEngine {
  private readonly skuLookup: Map<string, VmSku>;

  public constructor(private readonly catalog: RegionalCatalog) {
    this.skuLookup = new Map(catalog.skus.map((sku) => [sku.name.toLowerCase(), sku]));
  }

  public findRecommendations(
    sourceSku: string,
    region: string,
    os: OperatingSystem,
    cpuPolicy: CpuPolicy = 'prefer-same-vendor',
    requireUpgradeForEol = false,
  ): RecommendationResult {
    const source = this.skuLookup.get(sourceSku.trim().toLowerCase()) ?? null;
    const rejected = this.emptyStatistics();
    rejected.totalCandidates = this.catalog.skus.length;

    if (!source) {
      return this.emptyResult(
        sourceSku,
        region,
        os,
        'sku-not-found',
        `Not found in ${this.catalog.displayName}.`,
        rejected,
      );
    }

    const sourcePrice = this.priceFor(source, os);
    const mandatoryUpgrade =
      this.isRetired(source) || (requireUpgradeForEol && source.retirement !== null);
    const sourceMissing = this.missingCriticalCapabilities(source);
    if (sourceMissing.length > 0) {
      return {
        ...this.emptyResult(
          sourceSku,
          region,
          os,
          'incomplete-capabilities',
          `Azure metadata is incomplete (${sourceMissing.join(', ')}), so a safe recommendation cannot be made.`,
          rejected,
        ),
        source,
        confidence: 'Low',
        mandatoryUpgrade,
      };
    }

    const candidates: CandidateRecommendation[] = [];
    for (const candidate of this.catalog.skus) {
      const rejection = this.rejectionReason(source, candidate, os, cpuPolicy);
      if (rejection) {
        rejected[rejection]++;
        continue;
      }

      const hourlyPrice = this.priceFor(candidate, os)!;
      const monthlySaving = sourcePrice === null ? null : (sourcePrice - hourlyPrice) * 730;
      candidates.push({
        vm: candidate,
        score: this.score(source, candidate, sourcePrice, hourlyPrice, cpuPolicy),
        hourlyPrice,
        monthlySaving,
        savingPercent:
          sourcePrice !== null && sourcePrice > 0
            ? ((sourcePrice - hourlyPrice) / sourcePrice) * 100
            : null,
      });
    }

    candidates.sort(
      (left, right) =>
        right.score - left.score ||
        left.hourlyPrice - right.hourlyPrice ||
        left.vm.name.localeCompare(right.vm.name),
    );

    const recommendation = candidates[0] ?? null;
    if (!recommendation) {
      return {
        ...this.emptyResult(
          sourceSku,
          region,
          os,
          'no-compatible-replacement',
          'No compatible replacement with a usable regional price was found.',
          rejected,
        ),
        source,
        confidence: this.confidenceFor(source, null),
        mandatoryUpgrade,
      };
    }

    if (
      source.retirement === null &&
      !this.isMaterialUpgrade(source, recommendation.vm, sourcePrice, recommendation.hourlyPrice)
    ) {
      return {
        ...this.emptyResult(
          sourceSku,
          region,
          os,
          'no-upgrade-needed',
          'The current VM has no announced EOL, and no candidate provides a material price or same-vendor generation improvement.',
          rejected,
        ),
        source,
        alternatives: candidates.slice(0, 3),
        confidence: this.confidenceFor(source, recommendation.vm),
        mandatoryUpgrade: false,
      };
    }

    return {
      inputSku: sourceSku,
      status: sourcePrice === null ? 'source-price-missing' : 'recommended',
      region,
      os,
      source,
      recommendation,
      alternatives: candidates.slice(1, 4),
      rejected,
      explanation: this.explain(
        source,
        recommendation.vm,
        sourcePrice,
        recommendation.hourlyPrice,
        mandatoryUpgrade,
      ),
      confidence: this.confidenceFor(source, recommendation.vm),
      mandatoryUpgrade,
    };
  }

  public createQualityMatrix(
    operatingSystems: readonly OperatingSystem[] = ['linux'],
  ): QualityMatrixRow[] {
    const rows: QualityMatrixRow[] = [];
    for (const sku of this.qualityRepresentativeSkus()) {
      for (const os of operatingSystems) {
        for (const cpuPolicy of CPU_POLICIES) {
          const result = this.findRecommendations(sku.name, this.catalog.region, os, cpuPolicy);
          rows.push({
            region: this.catalog.region,
            family: sku.family,
            sourceSku: sku.name,
            os,
            cpuPolicy,
            status: result.status,
            recommendation: result.recommendation?.vm.name ?? '',
            sourceHourly: this.priceFor(sku, os),
            recommendedHourly: result.recommendation?.hourlyPrice ?? null,
            monthlySaving: result.recommendation?.monthlySaving ?? null,
            savingPercent: result.recommendation?.savingPercent ?? null,
            confidence: result.confidence,
            explanation: result.explanation,
            mandatoryUpgrade: result.mandatoryUpgrade,
            sourceEolDate: result.source?.retirement?.eolDate ?? '',
          });
        }
      }
    }

    return this.collapseIdenticalPolicyOutcomes(rows);
  }

  private collapseIdenticalPolicyOutcomes(rows: QualityMatrixRow[]): QualityMatrixRow[] {
    const collapsed = new Map<string, QualityMatrixRow>();
    for (const row of rows) {
      const outcomeKey = JSON.stringify([
        row.family,
        row.status,
        row.recommendation,
        row.recommendedHourly,
        row.monthlySaving,
        row.confidence,
        row.mandatoryUpgrade,
        row.sourceEolDate,
      ]);
      const existing = collapsed.get(outcomeKey);
      if (existing) {
        existing.cpuPolicy = `${existing.cpuPolicy} | ${row.cpuPolicy}`;
      } else {
        collapsed.set(outcomeKey, { ...row });
      }
    }
    return [...collapsed.values()];
  }

  private qualityRepresentativeSkus(): VmSku[] {
    const families = new Map<string, VmSku[]>();
    for (const sku of this.catalog.skus) {
      const key = sku.family || sku.name;
      const members = families.get(key) ?? [];
      members.push(sku);
      families.set(key, members);
    }

    return [...families.values()]
      .map(
        (members) =>
          members.sort(
            (left, right) =>
              Number(this.isConstrained(left)) - Number(this.isConstrained(right)) ||
              Number(this.priceFor(left, 'linux') === null) -
                Number(this.priceFor(right, 'linux') === null) ||
              (left.vcpusAvailable ?? Number.MAX_SAFE_INTEGER) -
                (right.vcpusAvailable ?? Number.MAX_SAFE_INTEGER) ||
              (left.memoryGB ?? Number.MAX_SAFE_INTEGER) -
                (right.memoryGB ?? Number.MAX_SAFE_INTEGER) ||
              left.name.localeCompare(right.name),
          )[0],
      )
      .sort((left, right) => left.family.localeCompare(right.family));
  }

  private rejectionReason(
    source: VmSku,
    candidate: VmSku,
    os: OperatingSystem,
    cpuPolicy: CpuPolicy,
  ): keyof Omit<RejectedCandidateStatistics, 'totalCandidates'> | null {
    if (candidate.name === source.name) return 'sourceSku';
    if (candidate.retirement !== null) return 'retirement';
    if (this.hasLocationRestriction(candidate, source.region)) return 'subscriptionRestriction';
    if (this.priceFor(candidate, os) === null) return 'price';
    if (!this.atLeast(candidate.vcpusAvailable, source.vcpusAvailable)) return 'usableVcpus';
    if (!this.isConstrained(source) && this.isConstrained(candidate)) return 'constrainedShape';
    if (!this.isBurstable(source) && this.isBurstable(candidate)) return 'burstableClass';
    if (
      source.workloadClass !== candidate.workloadClass &&
      (source.workloadClass !== null || candidate.workloadClass !== null)
    )
      return 'workloadAffinity';
    if ((source.gpus ?? 0) > 0 && !this.atLeast(candidate.gpus, source.gpus)) return 'gpus';
    if (!this.atLeast(candidate.memoryGB, source.memoryGB)) return 'memory';
    if (os === 'windows' && (source.tempDiskMB ?? 0) > 0 !== (candidate.tempDiskMB ?? 0) > 0)
      return 'tempDisk';
    if (source.premiumIO === true && candidate.premiumIO !== true) return 'premiumIO';
    if (source.acceleratedNetworking === true && candidate.acceleratedNetworking !== true)
      return 'acceleratedNetworking';
    if (source.rdma === true && candidate.rdma !== true) return 'rdma';
    if (source.architecture && candidate.architecture !== source.architecture)
      return 'architecture';
    if (cpuPolicy === 'same-vendor' && source.cpuVendor && candidate.cpuVendor !== source.cpuVendor)
      return 'cpuVendor';
    if (
      source.cpuVendor !== null &&
      source.cpuVendor === candidate.cpuVendor &&
      source.cpuGeneration !== null &&
      candidate.cpuGeneration !== null &&
      candidate.cpuGeneration < source.cpuGeneration
    )
      return 'olderGeneration';
    return null;
  }

  private score(
    source: VmSku,
    candidate: VmSku,
    sourcePrice: number | null,
    candidatePrice: number,
    cpuPolicy: CpuPolicy,
  ): number {
    let score = 1000;
    const usableCpuDelta = candidate.vcpusAvailable! - source.vcpusAvailable!;
    const memoryDelta = candidate.memoryGB! - source.memoryGB!;
    const physicalCpuDelta = Math.abs(
      (candidate.vcpus ?? candidate.vcpusAvailable!) - (source.vcpus ?? source.vcpusAvailable!),
    );

    score += usableCpuDelta === 0 ? 350 : -usableCpuDelta * 90;
    score += memoryDelta === 0 ? 300 : -memoryDelta * 18;
    score -= physicalCpuDelta * 12;
    score += this.isConstrained(source) === this.isConstrained(candidate) ? 120 : -120;

    if (
      source.maxDataDisks !== null &&
      candidate.maxDataDisks !== null &&
      candidate.maxDataDisks < source.maxDataDisks
    ) {
      score -= Math.min(100, (source.maxDataDisks - candidate.maxDataDisks) * 12.5);
    }

    if (source.cpuVendor && candidate.cpuVendor === source.cpuVendor) {
      score += cpuPolicy === 'prefer-same-vendor' ? 260 : 140;
    } else if (cpuPolicy === 'prefer-same-vendor' && source.cpuVendor) {
      score -= 180;
    }

    if (
      source.cpuVendor &&
      source.cpuVendor === candidate.cpuVendor &&
      source.cpuGeneration !== null &&
      candidate.cpuGeneration !== null
    ) {
      const generationDelta = candidate.cpuGeneration - source.cpuGeneration;
      score += generationDelta > 0 ? 320 + Math.min(generationDelta, 3) * 25 : 40;
    } else {
      score -= 60;
    }

    if ((source.tempDiskMB ?? 0) > 0 && (candidate.tempDiskMB ?? 0) > 0) {
      score += candidate.tempDiskMB === source.tempDiskMB ? 90 : 40;
    }

    if (sourcePrice !== null && sourcePrice > 0) {
      const priceRatio = candidatePrice / sourcePrice;
      score +=
        priceRatio <= 1
          ? Math.min(300, (1 - priceRatio) * 400)
          : -Math.min(1000, Math.log2(priceRatio) * 250);
    }
    return Math.round(score * 100) / 100;
  }

  private explain(
    source: VmSku,
    candidate: VmSku,
    sourcePrice: number | null,
    candidatePrice: number,
    mandatoryUpgrade: boolean,
  ): string {
    const reasons: string[] = [];
    if (
      candidate.vcpusAvailable === source.vcpusAvailable &&
      candidate.memoryGB === source.memoryGB
    ) {
      reasons.push('same usable CPU and memory');
    } else {
      reasons.push('required usable CPU and memory preserved');
    }
    if (source.cpuVendor && candidate.cpuVendor === source.cpuVendor) {
      reasons.push(
        `${source.cpuVendor}/${source.architecture ?? 'compatible architecture'} preserved`,
      );
    } else {
      reasons.push(`${source.architecture ?? 'architecture'} compatibility preserved`);
    }
    if ((source.tempDiskMB ?? 0) > 0 && (candidate.tempDiskMB ?? 0) > 0) {
      reasons.push('local temporary storage retained');
    } else if ((source.tempDiskMB ?? 0) > 0) {
      reasons.push('Linux supports resizing to a VM without local temporary storage');
    }
    if (source.premiumIO) reasons.push('Premium SSD supported');
    if (
      source.maxDataDisks !== null &&
      candidate.maxDataDisks !== null &&
      candidate.maxDataDisks < source.maxDataDisks
    ) {
      reasons.push(
        `reduced data disk limit (${candidate.maxDataDisks} vs ${source.maxDataDisks}) must be validated`,
      );
    }
    if (
      source.cpuGeneration !== null &&
      candidate.cpuGeneration !== null &&
      candidate.cpuGeneration > source.cpuGeneration
    )
      reasons.push('newer CPU generation');

    if (sourcePrice === null) {
      reasons.push(
        'candidate has a usable regional PAYG price, but the source PAYG price is unavailable',
      );
    } else {
      const savingPercent = ((sourcePrice - candidatePrice) / sourcePrice) * 100;
      reasons.push(
        savingPercent >= 0
          ? `${savingPercent.toFixed(1)}% lower PAYG price`
          : `${Math.abs(savingPercent).toFixed(1)}% higher PAYG price`,
      );
    }
    const explanation = `${this.sentenceList(reasons)}.`;
    if (!source.retirement) return explanation;
    if (this.isRetired(source)) {
      return `This VM retired on ${source.retirement.eolDate}; upgrading is required. ${explanation}`;
    }
    return mandatoryUpgrade
      ? `This VM has an announced EOL of ${source.retirement.eolDate}; the selected policy makes upgrading required. ${explanation}`
      : `This VM has an announced EOL of ${source.retirement.eolDate}; migration can be planned before that date. ${explanation}`;
  }

  private confidenceFor(source: VmSku, candidate: VmSku | null): Confidence {
    if (this.missingCriticalCapabilities(source).length > 0) return 'Low';
    if (
      !source.cpuVendor ||
      source.cpuGeneration === null ||
      !candidate ||
      !candidate.cpuVendor ||
      candidate.cpuGeneration === null
    )
      return 'Medium';
    if (
      candidate.vcpusAvailable === source.vcpusAvailable &&
      candidate.memoryGB === source.memoryGB &&
      (source.maxDataDisks === null ||
        candidate.maxDataDisks === null ||
        candidate.maxDataDisks >= source.maxDataDisks)
    )
      return 'High';
    return 'Medium';
  }

  private missingCriticalCapabilities(vm: VmSku): string[] {
    const missing: string[] = [];
    if (vm.vcpusAvailable === null) missing.push('usable vCPU');
    if (vm.memoryGB === null) missing.push('memory');
    if (vm.maxDataDisks === null) missing.push('data disk limit');
    if (vm.tempDiskMB === null) missing.push('temporary disk');
    if (vm.architecture === null) missing.push('architecture');
    return missing;
  }

  private priceFor(vm: VmSku, os: OperatingSystem): number | null {
    const price = os === 'linux' ? vm.prices.linuxPaygHourly : vm.prices.windowsPaygHourly;
    return price !== null && price > 0 ? price : null;
  }

  private atLeast(candidate: number | null, source: number | null): boolean {
    return source === null || (candidate !== null && candidate >= source);
  }

  private emptyStatistics(): RejectedCandidateStatistics {
    return {
      totalCandidates: 0,
      sourceSku: 0,
      price: 0,
      usableVcpus: 0,
      constrainedShape: 0,
      burstableClass: 0,
      workloadAffinity: 0,
      subscriptionRestriction: 0,
      gpus: 0,
      memory: 0,
      dataDisks: 0,
      tempDisk: 0,
      premiumIO: 0,
      acceleratedNetworking: 0,
      rdma: 0,
      architecture: 0,
      cpuVendor: 0,
      olderGeneration: 0,
      retirement: 0,
    };
  }

  private emptyResult(
    inputSku: string,
    region: string,
    os: OperatingSystem,
    status: RecommendationResult['status'],
    explanation: string,
    rejected: RejectedCandidateStatistics,
  ): RecommendationResult {
    return {
      inputSku,
      status,
      region,
      os,
      source: null,
      recommendation: null,
      alternatives: [],
      rejected,
      explanation,
      confidence: 'Low',
      mandatoryUpgrade: false,
    };
  }

  private isRetired(vm: VmSku): boolean {
    if (!vm.retirement) return false;
    const endOfLife = Date.parse(`${vm.retirement.eolDate}T23:59:59Z`);
    return Number.isFinite(endOfLife) && endOfLife < Date.now();
  }

  private isConstrained(vm: VmSku): boolean {
    return vm.vcpus !== null && vm.vcpusAvailable !== null && vm.vcpusAvailable < vm.vcpus;
  }

  private isBurstable(vm: VmSku): boolean {
    return BURSTABLE_FAMILIES.has(vm.family.toLowerCase());
  }

  private hasLocationRestriction(vm: VmSku, region: string): boolean {
    return vm.restrictions.some(
      (restriction) =>
        restriction.type.toLowerCase() === 'location' &&
        restriction.reasonCode === 'NotAvailableForSubscription' &&
        restriction.values.some((value) => value.toLowerCase() === region.toLowerCase()),
    );
  }

  private isMaterialUpgrade(
    source: VmSku,
    candidate: VmSku,
    sourcePrice: number | null,
    candidatePrice: number,
  ): boolean {
    if (sourcePrice !== null && candidatePrice < sourcePrice * 0.99) return true;
    return (
      source.cpuVendor !== null &&
      source.cpuVendor === candidate.cpuVendor &&
      source.cpuGeneration !== null &&
      candidate.cpuGeneration !== null &&
      candidate.cpuGeneration > source.cpuGeneration
    );
  }

  private sentenceList(values: string[]): string {
    if (values.length < 2) return values[0] ?? '';
    return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
  }
}
