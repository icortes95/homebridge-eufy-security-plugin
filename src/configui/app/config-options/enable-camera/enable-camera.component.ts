import { Component, OnInit, Input } from '@angular/core';
import { L_Device } from '../../../app/util/types';
import { PluginService } from '../../../app/plugin.service';
import { ConfigOptionsInterpreter } from '../config-options-interpreter';
import { NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'app-enable-camera',
    templateUrl: './enable-camera.component.html',
    standalone: true,
    imports: [FormsModule, NgIf],
})
export class EnableCameraComponent extends ConfigOptionsInterpreter implements OnInit {
  constructor(pluginService: PluginService) {
    super(pluginService);
  }

  ngOnInit(): void {
    this.readValue();
  }

  /** Customize from here */
  /** updateConfig() will overwrite any settings that you'll provide */
  /** Don't try and 'append'/'push' to arrays this way - add a custom method instead */
  /** see config option to ignore devices as example */

  /** updateConfig() takes an optional second parameter to specify the accessoriy for which the setting is changed */

  @Input() device?: L_Device;
  value = 'true';
  disabled = false;

  async readValue() {
    if (this.device && this.device.isDoorbell) {
      this.value = 'true';
      this.disabled = true;
      this.update();
    }

    const config = await this.getCameraConfig(this.device?.uniqueId || '');

    if (config && Object.prototype.hasOwnProperty.call(config, 'enableCamera')) {
      this.value = config['enableCamera'];
    }
  }

  update() {
    this.updateDeviceConfig(
      {
        enableCamera: JSON.parse(this.value),
      },
      this.device!,
    );
  }
}
