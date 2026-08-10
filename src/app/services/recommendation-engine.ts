import {
  CandidateRecommendation,
  CompatibilityCheck,
  Confidence,
  OperatingSystem,
  QualityMatrixRow,
  RecommendationOptions,
  RecommendationResult,
  RecommendationState,
  RecommendationType,
  RejectedCandidateStatistics,
  RegionalCatalog,
  VmSku,
} from '../models/vm.models';
import { isRetired, migrationGuideUrl } from './retirement-metadata';

/** Price difference, in percent, that separates a real saving from an equivalent modernization. */
const MATERIAL_SAVING_PERCENT = 5;

type CandidateCategory = 'compatible' | 'alternative-architecture' | 'manual-review';

type RejectionReason = keyof Omit<RejectedCandidateStatistics, 'totalCandidates'>;

interface Evaluation {
  category: CandidateCategory;
  checks: CompatibilityCheck[];
  notes: string[];
}

interface EvaluatedCandidate extends Evaluation {
  vm: VmSku;
  hourlyPrice: number;
  monthlySaving: number | null;
  savingPercent: number | null;
}

/**
 * Compatibility-first matcher.
 *
 * Candidates are selected in a fixed order: hardware compatibility, workload profile, regional
 * availability, lifecycle, performance equivalence and only then price. Price never overrides a
 * compatibility mismatch, and a candidate that fails a hard check can never become the primary
 * recommendation.
 */
export class RecommendationEngine {
  private readonly skuLookup: Map<string, VmSku>;

  public constructor(private readonly catalog: RegionalCatalog) {
    this.skuLookup = new Map(catalog.skus.map((sku) => [sku.name.toLowerCase(), sku]));
  }

  public findRecommendations(
    sourceSku: string,
    region: string,
    os: OperatingSystem,
    options: RecommendationOptions = {},
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

    const mandatoryUpgrade =
      source.lifecycleStatus === 'retired' || source.lifecycleStatus === 'retirementAnnounced';
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

    const sourcePrice = this.priceFor(source, os);
    const evaluated: EvaluatedCandidate[] = [];
    const migrationCandidates: EvaluatedCandidate[] = [];
    const modernizationCandidates: EvaluatedCandidate[] = [];
    const includeMigrationRecommendations =
      mandatoryUpgrade && options.includeMigrationRecommendations === true;
    const keepTempDisk = os !== 'linux' || options.keepTempDisk !== false;
    const allowTempDiskRemoval = os === 'linux' && !mandatoryUpgrade && !keepTempDisk;
    for (const candidate of this.catalog.skus) {
      const rejection = this.rejectionReason(source, candidate, os, allowTempDiskRemoval);
      const migrationEligible =
        includeMigrationRecommendations &&
        this.migrationRejectionReason(source, candidate, os, keepTempDisk) === null;
      const modernizationEligible = this.isModernizationCandidate(
        source,
        candidate,
        os,
        keepTempDisk,
      );
      if (rejection && !migrationEligible && !modernizationEligible) {
        rejected[rejection]++;
        continue;
      }
      if (rejection) rejected[rejection]++;

      const hourlyPrice = this.priceFor(candidate, os)!;
      const evaluation = this.evaluate(source, candidate, os, allowTempDiskRemoval);
      const evaluatedCandidate: EvaluatedCandidate = {
        vm: candidate,
        hourlyPrice,
        monthlySaving: sourcePrice === null ? null : (sourcePrice - hourlyPrice) * 730,
        savingPercent:
          sourcePrice !== null && sourcePrice > 0
            ? ((sourcePrice - hourlyPrice) / sourcePrice) * 100
            : null,
        ...evaluation,
      };
      if (!rejection) evaluated.push(evaluatedCandidate);
      if (migrationEligible) {
        migrationCandidates.push({
          ...evaluatedCandidate,
          notes: [
            'Best-fit migration: resource limits or workload profile may change and must be validated before migration.',
            ...evaluation.notes,
          ],
        });
      }
      if (modernizationEligible) {
        modernizationCandidates.push({
          ...evaluatedCandidate,
          notes: [
            'Generation modernization: validate temporary storage and resource-limit changes before resizing.',
            ...evaluation.notes,
          ],
        });
      }
    }

    const byCategory = (category: CandidateCategory): EvaluatedCandidate[] =>
      evaluated.filter((candidate) => candidate.category === category).sort(this.byPrice(source));

    const compatible = byCategory('compatible');
    const alternativeArchitecture = byCategory('alternative-architecture');
    const manualReview = byCategory('manual-review');

    const selection = this.select(
      source,
      mandatoryUpgrade,
      compatible,
      migrationCandidates.sort(this.byPrice(source)),
      modernizationCandidates.sort(this.byPrice(source)),
    );
    const primary = selection
      ? this.toCandidate(selection.candidate, selection.state, selection.recommendationType, source)
      : mandatoryUpgrade
        ? null
        : this.keepCandidate(source, os);
    const recommendationType: RecommendationType =
      primary?.recommendationType ?? (mandatoryUpgrade ? 'MANUAL_REVIEW' : 'KEEP');

    return {
      inputSku: sourceSku,
      status: primary
        ? primary.state
        : mandatoryUpgrade
          ? 'manual-migration-required'
          : 'no-safe-cheaper-replacement',
      region,
      os,
      source,
      recommendationType,
      sourceHourlyPrice: sourcePrice,
      recommendation: primary,
      alternatives: compatible
        .filter((candidate) => candidate.vm.name !== primary?.vm.name)
        .slice(0, 3)
        .map((candidate) => this.toCandidate(candidate, 'manual-review', 'MANUAL_REVIEW', source)),
      conditional: [],
      alternativeArchitecture: alternativeArchitecture
        .slice(0, 3)
        .map((candidate) =>
          this.toCandidate(candidate, 'alternative-architecture', 'MANUAL_REVIEW', source),
        ),
      manualReview: manualReview
        .slice(0, 3)
        .map((candidate) => this.toCandidate(candidate, 'manual-review', 'MANUAL_REVIEW', source)),
      rejected,
      explanation: this.explain(source, primary, mandatoryUpgrade, {
        alternativeArchitecture: alternativeArchitecture.length,
        manualReview: manualReview.length,
      }),
      confidence: this.confidenceFor(source, primary),
      mandatoryUpgrade,
    };
  }

  public createQualityMatrix(
    operatingSystems: readonly OperatingSystem[] = ['linux'],
  ): QualityMatrixRow[] {
    const rows: QualityMatrixRow[] = [];
    for (const sku of this.qualityRepresentativeSkus()) {
      for (const os of operatingSystems) {
        const result = this.findRecommendations(sku.name, this.catalog.region, os);
        rows.push({
          region: this.catalog.region,
          family: sku.family,
          sourceSku: sku.name,
          os,
          status: result.status,
          recommendationType: result.recommendationType,
          recommendation: result.recommendation?.vm.name ?? '',
          recommendationState: result.recommendation?.state ?? '',
          sourceHourly: this.priceFor(sku, os),
          recommendedHourly: result.recommendation?.hourlyPrice ?? null,
          monthlySaving: result.recommendation?.monthlySaving ?? null,
          savingPercent: result.recommendation?.savingPercent ?? null,
          confidence: result.confidence,
          explanation: result.explanation,
          mandatoryUpgrade: result.mandatoryUpgrade,
          sourceLifecycleStatus: sku.lifecycleStatus,
          sourceEolDate: result.source?.retirement?.eolDate ?? '',
        });
      }
    }
    return rows;
  }

  /**
   * Picks the primary recommendation. Price is only used once every hard compatibility check has
   * already passed.
   */
  private select(
    source: VmSku,
    mandatoryUpgrade: boolean,
    compatible: EvaluatedCandidate[],
    migrationCandidates: EvaluatedCandidate[],
    modernizationCandidates: EvaluatedCandidate[],
  ): {
    candidate: EvaluatedCandidate;
    state: RecommendationState;
    recommendationType: RecommendationType;
  } | null {
    const materiallyCheaper = (candidate: EvaluatedCandidate | null): boolean =>
      candidate !== null &&
      candidate.savingPercent !== null &&
      candidate.savingPercent >= MATERIAL_SAVING_PERCENT;

    if (mandatoryUpgrade) {
      const candidates = migrationCandidates.length > 0 ? migrationCandidates : compatible;
      const replacement = this.closestSizedCandidates(source, candidates)[0] ?? null;
      if (!replacement) return null;
      return {
        candidate: replacement,
        state: 'lifecycle-replacement',
        recommendationType: 'RETIREMENT_MIGRATION',
      };
    }

    const cheaperCandidates = this.closestSizedCandidates(
      source,
      compatible.filter((candidate) => materiallyCheaper(candidate)),
    );
    const cheapest = cheaperCandidates[0] ?? null;
    if (cheapest) {
      return {
        candidate: cheapest,
        state: 'recommended',
        recommendationType: 'COST_OPTIMIZATION',
      };
    }

    if (source.lifecycleStatus === 'previousGeneration') {
      const modernization = this.closestSizedCandidates(source, modernizationCandidates)[0];
      if (modernization && modernization.vm.vcpusAvailable === source.vcpusAvailable) {
        return {
          candidate: modernization,
          state: 'recommended',
          recommendationType: 'PERFORMANCE_UPGRADE',
        };
      }
    }

    return null;
  }

  /** Hard filters. A candidate rejected here is never surfaced, whatever it costs. */
  private rejectionReason(
    source: VmSku,
    candidate: VmSku,
    os: OperatingSystem,
    allowTempDiskRemoval = false,
  ): RejectionReason | null {
    if (candidate.name === source.name) return 'sourceSku';
    if (
      candidate.lifecycleStatus === 'retired' ||
      candidate.lifecycleStatus === 'retirementAnnounced'
    )
      return 'retirement';
    if (this.hasLocationRestriction(candidate, source.region)) return 'subscriptionRestriction';
    if (this.priceFor(candidate, os) === null) return 'price';
    if (source.profile.isolated !== candidate.profile.isolated) return 'isolatedProfile';
    if (!this.atLeast(candidate.vcpusAvailable, source.vcpusAvailable)) return 'usableVcpus';
    if (!this.atLeast(candidate.memoryGB, source.memoryGB)) return 'memory';
    if (
      this.isConstrained(source) !== this.isConstrained(candidate) ||
      (this.isConstrained(source) &&
        (source.vcpus !== candidate.vcpus || source.vcpusAvailable !== candidate.vcpusAvailable))
    )
      return 'constrainedShape';
    if (!source.profile.burstable && candidate.profile.burstable) return 'burstableClass';
    if (this.hasAccelerator(source) && !this.hasAccelerator(candidate)) return 'accelerator';
    if (this.hasAccelerator(source) && !this.atLeast(candidate.gpus, source.gpus))
      return 'accelerator';
    if (
      !this.localTempDiskCompatible(source, candidate, allowTempDiskRemoval) ||
      (source.profile.localNvme && !candidate.profile.localNvme) ||
      (source.profile.storageBandwidthOptimized && !candidate.profile.storageBandwidthOptimized) ||
      !this.atLeast(candidate.maxDataDisks, source.maxDataDisks)
    )
      return 'localStorage';
    if (source.premiumIO === true && candidate.premiumIO !== true) return 'premiumIO';
    if (
      (source.profile.networkOptimized && !candidate.profile.networkOptimized) ||
      (source.acceleratedNetworking === true && candidate.acceleratedNetworking !== true) ||
      (source.rdma === true && candidate.rdma !== true) ||
      !this.atLeast(candidate.maxNICs, source.maxNICs)
    )
      return 'network';
    if (this.isOlderGeneration(source, candidate)) return 'olderGeneration';
    return null;
  }

  /**
   * Best-fit migration filters. Unlike an in-place resize, a migration may change temp storage,
   * disk/NIC limits and workload family, but never processor domain, isolation, generation,
   * accelerator class, minimum capacity or specialized hardware capabilities.
   */
  private migrationRejectionReason(
    source: VmSku,
    candidate: VmSku,
    os: OperatingSystem,
    keepTempDisk = true,
  ): RejectionReason | 'processorDomain' | 'specializedProfile' | null {
    if (candidate.name === source.name) return 'sourceSku';
    if (
      candidate.lifecycleStatus === 'retired' ||
      candidate.lifecycleStatus === 'retirementAnnounced'
    )
      return 'retirement';
    if (this.hasLocationRestriction(candidate, source.region)) return 'subscriptionRestriction';
    if (this.priceFor(candidate, os) === null) return 'price';
    if (!this.isSameCpuVendor(source, candidate)) return 'processorDomain';
    if (
      source.cpuArchitecture === null ||
      candidate.cpuArchitecture === null ||
      source.cpuArchitecture !== candidate.cpuArchitecture
    )
      return 'processorDomain';
    if (source.profile.isolated !== candidate.profile.isolated) return 'isolatedProfile';
    if (this.isOlderGeneration(source, candidate)) return 'olderGeneration';
    if (!this.atLeast(candidate.vcpusAvailable, source.vcpusAvailable)) return 'usableVcpus';
    if (!this.atLeast(candidate.memoryGB, source.memoryGB)) return 'memory';
    if (this.isConstrained(source) !== this.isConstrained(candidate)) return 'constrainedShape';
    if (source.profile.burstable !== candidate.profile.burstable) return 'burstableClass';
    if (keepTempDisk && !this.localTempDiskCompatible(source, candidate)) return 'localStorage';
    if (!this.isSameAccelerator(source, candidate)) return 'accelerator';
    if (
      source.profile.confidential !== candidate.profile.confidential ||
      source.profile.hpc !== candidate.profile.hpc ||
      (source.profile.localNvme && !candidate.profile.localNvme) ||
      (source.profile.storageBandwidthOptimized && !candidate.profile.storageBandwidthOptimized) ||
      (source.profile.networkOptimized && !candidate.profile.networkOptimized) ||
      (source.rdma === true && candidate.rdma !== true)
    )
      return 'specializedProfile';
    return null;
  }

  private isModernizationCandidate(
    source: VmSku,
    candidate: VmSku,
    os: OperatingSystem,
    keepTempDisk: boolean,
  ): boolean {
    return (
      source.lifecycleStatus === 'previousGeneration' &&
      this.migrationRejectionReason(source, candidate, os, keepTempDisk) === null &&
      this.sameFamilyLineage(source, candidate) &&
      this.isSameWorkloadClass(source, candidate) &&
      candidate.vcpusAvailable === source.vcpusAvailable &&
      candidate.memoryGB === source.memoryGB &&
      this.atLeast(candidate.maxDataDisks, source.maxDataDisks) &&
      (source.premiumIO !== true || candidate.premiumIO === true) &&
      (!source.profile.networkOptimized || candidate.profile.networkOptimized) &&
      (source.acceleratedNetworking !== true || candidate.acceleratedNetworking === true) &&
      (source.rdma !== true || candidate.rdma === true) &&
      this.atLeast(candidate.maxNICs, source.maxNICs) &&
      (!source.hyperVGenerations.includes('V1') || candidate.hyperVGenerations.includes('V1')) &&
      this.isNewerGeneration(source, candidate)
    );
  }

  /** Classifies a surviving candidate and produces the comparison badges shown in the UI. */
  private evaluate(
    source: VmSku,
    candidate: VmSku,
    os: OperatingSystem,
    allowTempDiskRemoval = false,
  ): Evaluation {
    const checks: CompatibilityCheck[] = [];
    const notes: string[] = [];
    const manual: string[] = [];

    const sameVendor = this.isSameCpuVendor(source, candidate);
    const sameArchitecture =
      source.cpuArchitecture !== null && source.cpuArchitecture === candidate.cpuArchitecture;
    checks.push(
      this.check(
        'cpuVendor',
        'Same CPU vendor',
        sameVendor,
        sameVendor
          ? `${candidate.cpuVendor ?? 'Unknown'} preserved`
          : `${source.cpuVendor ?? 'Unknown'} → ${candidate.cpuVendor ?? 'Unknown'}`,
      ),
      this.check(
        'architecture',
        'Same architecture',
        sameArchitecture,
        sameArchitecture
          ? `${candidate.cpuArchitecture}`
          : `${source.cpuArchitecture ?? 'Unknown'} → ${candidate.cpuArchitecture ?? 'Unknown'}`,
      ),
    );

    const sameFamily = this.isSameWorkloadClass(source, candidate);
    checks.push(
      this.check(
        'workloadFamily',
        'Same workload family',
        sameFamily,
        sameFamily
          ? `${candidate.workloadFamily ?? 'Unknown'}-series`
          : `${source.workloadFamily ?? 'Unknown'} → ${candidate.workloadFamily ?? 'Unknown'}`,
      ),
    );
    if (!sameFamily) manual.push('workload family or profile changes');

    checks.push(
      this.check(
        'vcpus',
        'Same or greater vCPU',
        true,
        `${source.vcpusAvailable} → ${candidate.vcpusAvailable} usable vCPU`,
      ),
      this.check(
        'memory',
        'Same or greater RAM',
        true,
        `${source.memoryGB} GB → ${candidate.memoryGB} GB`,
      ),
    );

    const localStorageKept = this.localTempDiskCompatible(source, candidate);
    const tempDiskRemovalAllowed =
      allowTempDiskRemoval && source.profile.localTempDisk && !candidate.profile.localTempDisk;
    const nvmeKept = !source.profile.localNvme || candidate.profile.localNvme;
    const storageBandwidthKept =
      !source.profile.storageBandwidthOptimized || candidate.profile.storageBandwidthOptimized;
    const dataDisksKept = this.atLeast(candidate.maxDataDisks, source.maxDataDisks);
    const storagePassed = localStorageKept && nvmeKept && storageBandwidthKept && dataDisksKept;
    checks.push(
      this.check(
        'storage',
        'Storage requirements preserved',
        storagePassed,
        this.storageDetail(source, candidate, {
          localStorageKept,
          nvmeKept,
          storageBandwidthKept,
          dataDisksKept,
        }),
      ),
    );
    if (!nvmeKept) manual.push('local NVMe storage is dropped');
    if (!storageBandwidthKept) manual.push('storage-bandwidth optimization is dropped');
    if (!localStorageKept) {
      if (tempDiskRemovalAllowed) {
        notes.push(
          'Warning: the target has no local temporary disk. Data and mounts on the source temp disk are not available on the target; move required data to persistent storage and reconfigure swap or temporary workloads before resizing.',
        );
      } else {
        manual.push('local/temp disk capacity is reduced');
      }
    }
    if (!dataDisksKept) manual.push('the data disk limit is reduced');

    const networkOptimizationKept =
      !source.profile.networkOptimized || candidate.profile.networkOptimized;
    const acceleratedNetworkingKept =
      source.acceleratedNetworking !== true || candidate.acceleratedNetworking === true;
    const rdmaKept = source.rdma !== true || candidate.rdma === true;
    const nicsKept = this.atLeast(candidate.maxNICs, source.maxNICs);
    const networkPassed =
      networkOptimizationKept && acceleratedNetworkingKept && rdmaKept && nicsKept;
    checks.push(
      this.check(
        'network',
        'Network requirements preserved',
        networkPassed,
        networkPassed
          ? `${candidate.maxNICs ?? 'Unknown'} NICs, accelerated networking ${candidate.acceleratedNetworking ? 'supported' : 'not supported'}`
          : 'Network bandwidth, NIC count, accelerated networking or RDMA is reduced',
      ),
    );
    if (!networkPassed) manual.push('network capabilities are reduced');

    const acceleratorPassed = this.isSameAccelerator(source, candidate);
    checks.push(
      this.check(
        'accelerator',
        'Accelerator preserved',
        acceleratorPassed,
        this.acceleratorDetail(source, candidate),
      ),
    );
    if (!acceleratorPassed) manual.push('the accelerator model or class changes');

    checks.push(
      this.check(
        'generation',
        'Same or newer generation',
        true,
        `${this.generationLabel(source)} → ${this.generationLabel(candidate)}`,
      ),
      this.check('region', 'Available in region', true, this.catalog.displayName),
    );

    const hyperVKept =
      !source.hyperVGenerations.includes('V1') || candidate.hyperVGenerations.includes('V1');
    if (!hyperVKept) manual.push('Generation 1 images are not supported by the target');

    let category: CandidateCategory = 'compatible';
    if (manual.length > 0) {
      category = 'manual-review';
      notes.push(`Manual review: ${this.sentenceList(manual)}.`);
    } else if (!sameVendor || !sameArchitecture) {
      category = 'alternative-architecture';
      notes.push(
        'Alternative architecture: a processor vendor or architecture change must be validated and is never selected automatically.',
      );
    }

    return { category, checks, notes };
  }

  private toCandidate(
    candidate: EvaluatedCandidate,
    state: RecommendationState,
    recommendationType: RecommendationType,
    source: VmSku,
  ): CandidateRecommendation {
    const capabilityChanges = this.capabilityChanges(source, candidate.vm);
    return {
      vm: candidate.vm,
      state,
      recommendationType,
      hourlyPrice: candidate.hourlyPrice,
      hourlySaving: candidate.monthlySaving === null ? null : candidate.monthlySaving / 730,
      monthlySaving: candidate.monthlySaving,
      savingPercent: candidate.savingPercent,
      cpuVendorChange: !this.isSameCpuVendor(source, candidate.vm),
      resourceDifference: {
        usableVcpus: (candidate.vm.vcpusAvailable ?? 0) - (source.vcpusAvailable ?? 0),
        memoryGB: (candidate.vm.memoryGB ?? 0) - (source.memoryGB ?? 0),
      },
      ...capabilityChanges,
      checks: candidate.checks,
      notes: candidate.notes,
    };
  }

  private keepCandidate(source: VmSku, os: OperatingSystem): CandidateRecommendation {
    return {
      vm: source,
      state: 'keep',
      recommendationType: 'KEEP',
      hourlyPrice: this.priceFor(source, os),
      hourlySaving: 0,
      monthlySaving: 0,
      savingPercent: 0,
      cpuVendorChange: false,
      resourceDifference: { usableVcpus: 0, memoryGB: 0 },
      lostCapabilities: [],
      gainedCapabilities: [],
      checks: this.evaluate(source, source, os).checks,
      notes: [],
    };
  }

  private capabilityChanges(
    source: VmSku,
    candidate: VmSku,
  ): Pick<CandidateRecommendation, 'lostCapabilities' | 'gainedCapabilities'> {
    const lostCapabilities: string[] = [];
    const gainedCapabilities: string[] = [];
    const compare = (label: string, sourceHas: boolean, candidateHas: boolean): void => {
      if (sourceHas && !candidateHas) lostCapabilities.push(label);
      if (!sourceHas && candidateHas) gainedCapabilities.push(label);
    };
    compare('local/temp disk', source.profile.localTempDisk, candidate.profile.localTempDisk);
    compare('local NVMe', source.profile.localNvme, candidate.profile.localNvme);
    compare('Premium SSD', source.premiumIO === true, candidate.premiumIO === true);
    compare(
      'accelerated networking',
      source.acceleratedNetworking === true,
      candidate.acceleratedNetworking === true,
    );
    compare('RDMA/InfiniBand', source.rdma === true, candidate.rdma === true);
    compare('confidential computing', source.profile.confidential, candidate.profile.confidential);
    compare('HPC profile', source.profile.hpc, candidate.profile.hpc);
    compare('accelerator', this.hasAccelerator(source), this.hasAccelerator(candidate));
    return { lostCapabilities, gainedCapabilities };
  }

  private closestSizedCandidates(
    source: VmSku,
    candidates: EvaluatedCandidate[],
  ): EvaluatedCandidate[] {
    const exact = candidates.filter(
      (candidate) =>
        candidate.vm.vcpusAvailable === source.vcpusAvailable &&
        candidate.vm.memoryGB === source.memoryGB,
    );
    if (exact.length > 0) return exact;

    const sameCpu = candidates.filter(
      (candidate) => candidate.vm.vcpusAvailable === source.vcpusAvailable,
    );
    return sameCpu.length > 0 ? sameCpu : candidates;
  }

  /** Cheapest first, then closest to the source shape, then the newest series. */
  private byPrice(source: VmSku): (left: EvaluatedCandidate, right: EvaluatedCandidate) => number {
    const distance = (value: number | null, reference: number | null): number =>
      Math.abs((value ?? 0) - (reference ?? 0));
    return (left, right) =>
      left.hourlyPrice - right.hourlyPrice ||
      distance(left.vm.vcpusAvailable, source.vcpusAvailable) -
        distance(right.vm.vcpusAvailable, source.vcpusAvailable) ||
      distance(left.vm.memoryGB, source.memoryGB) - distance(right.vm.memoryGB, source.memoryGB) ||
      (right.vm.seriesVersion ?? 0) - (left.vm.seriesVersion ?? 0) ||
      Number(this.isNewerGeneration(source, right.vm)) -
        Number(this.isNewerGeneration(source, left.vm)) ||
      left.vm.name.localeCompare(right.vm.name);
  }

  private explain(
    source: VmSku,
    recommendation: CandidateRecommendation | null,
    mandatoryUpgrade: boolean,
    remaining: { alternativeArchitecture: number; manualReview: number },
  ): string {
    const lifecycle = this.lifecycleSentence(source);
    if (recommendation?.recommendationType === 'KEEP') {
      return [
        lifecycle,
        'Keep the current VM: it is supported and no fully compatible alternative is at least 5% cheaper.',
      ]
        .filter(Boolean)
        .join(' ');
    }
    if (!recommendation) {
      const options: string[] = [];
      if (remaining.alternativeArchitecture > 0) {
        options.push(
          `${remaining.alternativeArchitecture} alternative-architecture option(s) require a CPU vendor or architecture change`,
        );
      }
      if (remaining.manualReview > 0) {
        options.push(`${remaining.manualReview} option(s) need manual review`);
      }
      const summary = mandatoryUpgrade
        ? 'Manual migration required: no same-vendor, same-profile successor is available in this region.'
        : 'No safe cheaper replacement: every cheaper candidate fails at least one hard compatibility rule.';
      return [lifecycle, summary, options.length > 0 ? `${this.sentenceList(options)}.` : '']
        .filter(Boolean)
        .join(' ');
    }

    const reasons: string[] = [];
    const candidate = recommendation.vm;
    if (candidate.cpuVendor && candidate.cpuVendor === source.cpuVendor) {
      reasons.push(
        `${candidate.cpuVendor} ${candidate.cpuArchitecture ?? ''}`.trim() + ' preserved',
      );
    } else if (candidate.cpuArchitecture === source.cpuArchitecture) {
      reasons.push(`${candidate.cpuArchitecture ?? 'architecture'} preserved`);
    }
    if (source.workloadFamily && source.workloadFamily === candidate.workloadFamily) {
      reasons.push(`${source.workloadFamily}-series workload profile kept`);
    }
    reasons.push(
      candidate.vcpusAvailable === source.vcpusAvailable && candidate.memoryGB === source.memoryGB
        ? 'same usable vCPU and memory'
        : 'usable vCPU and memory preserved',
    );
    if (this.isNewerGeneration(source, candidate)) reasons.push('newer generation');
    if (recommendation.savingPercent === null) {
      reasons.push('the source PAYG price is unavailable, so no saving is claimed');
    } else {
      reasons.push(
        recommendation.savingPercent >= 0
          ? `${recommendation.savingPercent.toFixed(1)}% lower PAYG price`
          : `${Math.abs(recommendation.savingPercent).toFixed(1)}% higher PAYG price`,
      );
    }

    const state =
      recommendation.state === 'lifecycle-replacement'
        ? 'Lifecycle replacement – not a cost saving.'
        : recommendation.recommendationType === 'PERFORMANCE_UPGRADE'
          ? 'Generation modernization.'
          : 'Cost optimization.';

    return [lifecycle, state, `${this.sentenceList(reasons)}.`, ...recommendation.notes]
      .filter(Boolean)
      .join(' ');
  }

  private lifecycleSentence(source: VmSku): string {
    if (!source.retirement) return '';
    const guide = migrationGuideUrl(source.retirement);
    const suffix = guide ? ` Microsoft migration guidance: ${guide}.` : '';
    if (isRetired(source.retirement)) {
      return `This VM retired on ${source.retirement.eolDate}; upgrading is required.${suffix}`;
    }
    return `This VM has an announced EOL of ${source.retirement.eolDate}; migration is required before that date.${suffix}`;
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

  private check(
    id: CompatibilityCheck['id'],
    label: string,
    passed: boolean,
    detail: string,
  ): CompatibilityCheck {
    return { id, label, passed, detail };
  }

  /**
   * Intel and AMD are never interchanged. Arm64 SKUs stay Arm64, where the Ampere Altra and Azure
   * Cobalt platforms share the same instruction set and are treated as one vendor domain.
   */
  private isSameCpuVendor(source: VmSku, candidate: VmSku): boolean {
    if (source.cpuVendor === null || candidate.cpuVendor === null) return false;
    if (source.cpuVendor === candidate.cpuVendor) return true;
    return source.cpuArchitecture === 'arm64' && candidate.cpuArchitecture === 'arm64';
  }

  private isSameWorkloadClass(source: VmSku, candidate: VmSku): boolean {
    if (source.workloadFamily === null || candidate.workloadFamily === null) return false;
    if (source.workloadFamily !== candidate.workloadFamily) return false;
    return (
      source.profile.burstable === candidate.profile.burstable &&
      source.profile.confidential === candidate.profile.confidential &&
      source.profile.hpc === candidate.profile.hpc &&
      source.profile.isolated === candidate.profile.isolated
    );
  }

  private sameFamilyLineage(source: VmSku, candidate: VmSku): boolean {
    const lineage = (family: string): string =>
      family.replace(/v\d+(?=family$)/i, '').toLowerCase();
    return lineage(source.family) === lineage(candidate.family);
  }

  private isSameAccelerator(source: VmSku, candidate: VmSku): boolean {
    if (!this.hasAccelerator(source)) return !this.hasAccelerator(candidate);
    if (!this.hasAccelerator(candidate)) return false;
    if (!source.accelerator || !candidate.accelerator) return false;
    return (
      source.accelerator.vendor === candidate.accelerator.vendor &&
      source.accelerator.model === candidate.accelerator.model &&
      source.accelerator.workload === candidate.accelerator.workload
    );
  }

  private hasAccelerator(vm: VmSku): boolean {
    return (vm.gpus ?? 0) > 0 || vm.accelerator !== null;
  }

  private isOlderGeneration(source: VmSku, candidate: VmSku): boolean {
    if (
      source.workloadFamily !== null &&
      source.workloadFamily === candidate.workloadFamily &&
      source.seriesVersion !== null &&
      candidate.seriesVersion !== null &&
      candidate.seriesVersion < source.seriesVersion
    )
      return true;
    return (
      this.isSameCpuVendor(source, candidate) &&
      source.cpuGeneration !== null &&
      candidate.cpuGeneration !== null &&
      candidate.cpuGeneration < source.cpuGeneration
    );
  }

  private isNewerGeneration(source: VmSku, candidate: VmSku): boolean {
    if (this.isOlderGeneration(source, candidate)) return false;
    if (
      source.seriesVersion !== null &&
      candidate.seriesVersion !== null &&
      source.workloadFamily === candidate.workloadFamily &&
      candidate.seriesVersion > source.seriesVersion
    )
      return true;
    return (
      source.cpuGeneration !== null &&
      candidate.cpuGeneration !== null &&
      this.isSameCpuVendor(source, candidate) &&
      candidate.cpuGeneration > source.cpuGeneration
    );
  }

  private generationLabel(vm: VmSku): string {
    const series =
      vm.workloadFamily && vm.seriesVersion
        ? `${vm.workloadFamily}v${vm.seriesVersion}`
        : vm.family;
    return vm.cpuModel ? `${series} (${vm.cpuModel})` : series;
  }

  private storageDetail(
    source: VmSku,
    candidate: VmSku,
    kept: {
      localStorageKept: boolean;
      nvmeKept: boolean;
      storageBandwidthKept: boolean;
      dataDisksKept: boolean;
    },
  ): string {
    if (!kept.nvmeKept) return 'Local NVMe storage is not available on the target';
    if (!kept.storageBandwidthKept) return 'Storage-bandwidth optimization is not preserved';
    if (!kept.localStorageKept)
      return `Local/temp disk ${this.localStorage(source)} → ${this.localStorage(candidate)}`;
    if (!kept.dataDisksKept)
      return `Data disk limit ${source.maxDataDisks} → ${candidate.maxDataDisks}`;
    return `Local/temp disk ${this.localStorage(candidate)}, ${candidate.maxDataDisks} data disks`;
  }

  private localTempDiskCompatible(source: VmSku, candidate: VmSku, allowRemoval = false): boolean {
    if (source.profile.localTempDisk !== candidate.profile.localTempDisk) {
      return allowRemoval && source.profile.localTempDisk && !candidate.profile.localTempDisk;
    }
    return !source.profile.localTempDisk || this.atLeast(candidate.tempDiskMB, source.tempDiskMB);
  }

  /**
   * Describes the local/temp disk. Azure reports MaxResourceVolumeMB = 0 for newer sizes, so the
   * curated capability flag decides whether local storage exists at all.
   */
  private localStorage(vm: VmSku): string {
    if (!vm.profile.localTempDisk) return 'none';
    return (vm.tempDiskMB ?? 0) > 0 ? this.gib(vm.tempDiskMB) : 'included';
  }

  private acceleratorDetail(source: VmSku, candidate: VmSku): string {
    if (!this.hasAccelerator(source)) {
      return this.hasAccelerator(candidate) ? 'Target adds an accelerator' : 'No accelerator';
    }
    const describe = (vm: VmSku): string =>
      vm.accelerator
        ? `${vm.gpus ?? '?'}× ${vm.accelerator.vendor} ${vm.accelerator.model}`
        : 'None';
    return `${describe(source)} → ${describe(candidate)}`;
  }

  private confidenceFor(source: VmSku, candidate: CandidateRecommendation | null): Confidence {
    if (this.missingCriticalCapabilities(source).length > 0) return 'Low';
    if (!candidate) return source.cpuVendor && source.workloadFamily ? 'Medium' : 'Low';
    if (
      !source.cpuVendor ||
      source.cpuGeneration === null ||
      !candidate.vm.cpuVendor ||
      candidate.vm.cpuGeneration === null
    )
      return 'Medium';
    return candidate.checks.every((check) => check.passed) ? 'High' : 'Medium';
  }

  private missingCriticalCapabilities(vm: VmSku): string[] {
    const missing: string[] = [];
    if (vm.vcpusAvailable === null) missing.push('usable vCPU');
    if (vm.memoryGB === null) missing.push('memory');
    if (vm.maxDataDisks === null) missing.push('data disk limit');
    if (vm.tempDiskMB === null) missing.push('temporary disk');
    if (vm.cpuArchitecture === null) missing.push('architecture');
    return missing;
  }

  private priceFor(vm: VmSku, os: OperatingSystem): number | null {
    const price = os === 'linux' ? vm.prices.linuxPaygHourly : vm.prices.windowsPaygHourly;
    return price !== null && price > 0 ? price : null;
  }

  private atLeast(candidate: number | null, source: number | null): boolean {
    return source === null || (candidate !== null && candidate >= source);
  }

  private gib(megabytes: number | null): string {
    return megabytes === null ? 'Unknown' : `${Math.round(megabytes / 1024)} GiB`;
  }

  private emptyStatistics(): RejectedCandidateStatistics {
    return {
      totalCandidates: 0,
      sourceSku: 0,
      price: 0,
      subscriptionRestriction: 0,
      retirement: 0,
      olderGeneration: 0,
      usableVcpus: 0,
      memory: 0,
      constrainedShape: 0,
      burstableClass: 0,
      isolatedProfile: 0,
      localStorage: 0,
      premiumIO: 0,
      network: 0,
      accelerator: 0,
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
      recommendationType: 'MANUAL_REVIEW',
      sourceHourlyPrice: null,
      recommendation: null,
      alternatives: [],
      conditional: [],
      alternativeArchitecture: [],
      manualReview: [],
      rejected,
      explanation,
      confidence: 'Low',
      mandatoryUpgrade: false,
    };
  }

  private isConstrained(vm: VmSku): boolean {
    return vm.vcpus !== null && vm.vcpusAvailable !== null && vm.vcpusAvailable < vm.vcpus;
  }

  private hasLocationRestriction(vm: VmSku, region: string): boolean {
    return vm.restrictions.some(
      (restriction) =>
        restriction.type.toLowerCase() === 'location' &&
        restriction.reasonCode === 'NotAvailableForSubscription' &&
        restriction.values.some((value) => value.toLowerCase() === region.toLowerCase()),
    );
  }

  private sentenceList(values: string[]): string {
    if (values.length < 2) return values[0] ?? '';
    return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
  }
}
