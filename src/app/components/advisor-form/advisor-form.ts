import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CpuPolicy, OperatingSystem, RegionInfo } from '../../models/vm.models';

export interface AdvisorRequest {
  region: string;
  os: OperatingSystem;
  cpuPolicy: CpuPolicy;
  skus: string[];
}

@Component({
  selector: 'app-advisor-form',
  imports: [FormsModule],
  templateUrl: './advisor-form.html',
  styleUrl: './advisor-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdvisorFormComponent {
  public readonly regions = input.required<RegionInfo[]>();
  public readonly busy = input(false);
  public readonly findUpgrades = output<AdvisorRequest>();

  protected region = '';
  protected os: OperatingSystem = 'linux';
  protected cpuPolicy: CpuPolicy = 'prefer-same-vendor';
  protected skuInput = [
    'Standard_DS3_v2',
    'Standard_E32ds_v4',
    'Standard_D4as_v4',
    'Standard_E16-4as_v4'
  ].join('\n');
  protected readonly validationError = signal('');

  protected submit(): void {
    const skus = [...new Set(
      this.skuInput.split(/[\r\n,;\t]+/).map((value) => value.trim()).filter(Boolean)
    )];
    if (!this.region) {
      this.validationError.set('Select an Azure region.');
      return;
    }
    if (skus.length === 0) {
      this.validationError.set('Enter at least one VM size.');
      return;
    }

    this.validationError.set('');
    this.findUpgrades.emit({ region: this.region, os: this.os, cpuPolicy: this.cpuPolicy, skus });
  }
}
