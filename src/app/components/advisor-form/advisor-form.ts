import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyCode, OperatingSystem, RegionInfo } from '../../models/vm.models';

export interface AdvisorRequest {
  region: string;
  os: OperatingSystem;
  currency: CurrencyCode;
  skus: string[];
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
  public readonly regions = input.required<RegionInfo[]>();
  public readonly busy = input(false);
  public readonly findUpgrades = output<AdvisorRequest>();

  protected region = '';
  protected os: OperatingSystem = 'linux';
  protected currency: CurrencyCode = 'GBP';
  protected skuInput = ['Standard_D2as_v5', 'Standard_B2ats_v2', 'Standard_A1_v2'].join('\n');
  protected readonly validationError = signal('');

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
