import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyCode, OperatingSystem, RegionInfo } from '../../models/vm.models';

export interface AdvisorRequest {
  region: string;
  os: OperatingSystem;
  currency: CurrencyCode;
  skus: string[];
  keepTempDisk: boolean;
  keepCpuVendor: boolean;
}

@Component({
  selector: 'app-advisor-form',
  imports: [FormsModule],
  templateUrl: './advisor-form.html',
  styleUrl: './advisor-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdvisorFormComponent {
  private readonly regionStorageKey = 'azure-vm-upgrade-advisor.region';
  private readonly regionCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
  public readonly regions = input.required<RegionInfo[]>();
  public readonly busy = input(false);
  public readonly findUpgrades = output<AdvisorRequest>();

  protected region = '';
  protected os: OperatingSystem = 'linux';
  protected currency: CurrencyCode = 'GBP';
  protected keepTempDisk = true;
  protected keepCpuVendor = true;
  protected skuInput = ['Standard_D2s_v3', 'Standard_D2s_v4','Standard_D2s_v5', 'Standard_B2ats_v2', 'Standard_A1_v2', 'Standard_F16s_v2'].join('\n');
  protected readonly validationError = signal('');
  protected readonly regionSearch = signal('');
  protected readonly filteredRegions = computed(() => {
    const query = this.regionSearch().trim().toLocaleLowerCase();
    return this.regions()
      .filter(
        (region) =>
          query.length === 0 ||
          region.displayName.toLocaleLowerCase().includes(query) ||
          region.name.toLocaleLowerCase().includes(query),
      )
      .sort(
        (left, right) =>
          this.regionCollator.compare(left.displayName, right.displayName) ||
          this.regionCollator.compare(left.name, right.name),
      );
  });

  public constructor() {
    effect(() => {
      const regions = this.regions();
      if (this.region || regions.length === 0) return;
      const storedRegion = this.readStoredRegion();
      if (storedRegion && regions.some((region) => region.name === storedRegion)) {
        this.region = storedRegion;
      }
    });
  }

  protected selectRegion(region: string): void {
    this.region = region;
    try {
      localStorage.setItem(this.regionStorageKey, region);
    } catch (error) {
      console.warn('Unable to persist the selected Azure region.', error);
    }
  }

  protected submit(): void {
    const skus = [
      ...new Set(
        this.skuInput
          .split(/[\r\n,;\t]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!this.region) {
      this.validationError.set('Select an Azure region.');
      return;
    }
    if (skus.length === 0) {
      this.validationError.set('Enter at least one VM size.');
      return;
    }

    this.validationError.set('');
    this.findUpgrades.emit({
      region: this.region,
      os: this.os,
      currency: this.currency,
      skus,
      keepTempDisk: this.os === 'linux' ? this.keepTempDisk : true,
      keepCpuVendor: this.keepCpuVendor,
    });
  }

  private readStoredRegion(): string | null {
    try {
      return localStorage.getItem(this.regionStorageKey);
    } catch (error) {
      console.warn('Unable to restore the selected Azure region.', error);
      return null;
    }
  }
}
