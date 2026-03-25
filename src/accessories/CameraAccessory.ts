import {
  PlatformAccessory,
  Characteristic,
  CharacteristicValue,
  Resolution,
  CameraControllerOptions,
  SRTPCryptoSuites,
  H264Profile,
  H264Level,
  EventTriggerOption,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  MediaContainerType,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
} from 'homebridge';

import { EufySecurityPlatform } from '../platform.js';
import { DeviceAccessory } from './Device.js';


// @ts-ignore
import { Camera, DeviceEvents, PropertyName, CommandName, StreamMetadata, PropertyValue, GarageDoorState } from 'eufy-security-client';

import { CameraConfig, DEFAULT_CAMERACONFIG_VALUES } from '../utils/configTypes.js';
import { CHAR, SERV } from '../utils/utils.js';
import { StreamingDelegate } from '../controller/streamingDelegate.js';
import { RecordingDelegate } from '../controller/recordingDelegate.js';

// A semi-complete description of the UniFi Protect camera channel JSON.
export interface ProtectCameraChannelConfig {

  bitrate: number;
  enabled: boolean;
  fps: number;
  height: number;
  id: number;
  idrInterval: number;
  isRtspEnabled: boolean;
  name: string;
  width: number;
}

export interface RtspEntry {

  channel: ProtectCameraChannelConfig;
  lens?: number;
  name: string;
  resolution: Resolution;
  url: string;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class CameraAccessory extends DeviceAccessory {

  // Define the object variable to hold the boolean and timestamp
  protected cameraStatus: { isEnabled: boolean; timestamp: number };
  private notificationTimeout: NodeJS.Timeout | null = null;

  public readonly cameraConfig: CameraConfig;

  public hardwareTranscoding: boolean = true;
  public hardwareDecoding: boolean = true;
  public timeshift: boolean = false;
  public hksvRecording: boolean = true;
  public HksvErrors: number = 0;

  public isOnline: boolean = true;

  public rtsp_url: string = '';

  public metadata!: StreamMetadata;

  public standalone: boolean = false;

  // List of event types
  public readonly eventTypesToHandle: (keyof DeviceEvents)[] = [
    'motion detected',
    'person detected',
    'pet detected',
    'vehicle detected',
    'sound detected',
    'crying detected',
    'dog detected',
    'stranger person detected',
  ];

  protected streamingDelegate: StreamingDelegate | null = null;
  protected recordingDelegate?: RecordingDelegate | null = null;

  private doorStates: Map<number, number> = new Map();
  private doorCharacteristics: Map<number, { current: Characteristic; target: Characteristic }> = new Map();

  public resolutions: Resolution[] = [
    [1920, 1024, 30],
    [1280, 720, 30],
    [1024, 768, 30],
    [640, 480, 30],
    [640, 360, 30],
    [480, 360, 30],
    [480, 270, 30],
    [320, 240, 30],
    [320, 240, 15], // Apple Watch requires this configuration
    [320, 180, 30],
  ];

  constructor(
    platform: EufySecurityPlatform,
    accessory: PlatformAccessory,
    device: Camera,
  ) {
    super(platform, accessory, device);

    this.cameraConfig = {} as CameraConfig;

    this.cameraStatus = { isEnabled: false, timestamp: 0 }; // Initialize the cameraStatus object

    this.log.debug(`Constructed Camera`);

    this.cameraConfig = this.getCameraConfig();

    this.standalone = device.getSerial() === device.getStationSerial();

    this.log.debug(`Is standalone?`, this.standalone);

    if (this.cameraConfig.enableCamera) {
      this.log.debug(`has a camera: Setting up camera.`);
      this.setupCamera();
    } else {
      this.log.debug(`has a motion sensor: Setting up motion.`);
      this.setupMotionFunction();
    }

    this.initSensorService();

    this.setupEnableButton();
    this.setupMotionButton();
    this.setupLightButton();
    this.setupChimeButton();
    if (this.device.isGarageCamera()) {
      this.log.debug(`${this.accessory.displayName} is a garage control camera`);
      this.setupGarageDoorOpener();
    }

    this.pruneUnusedServices();
  }

  private setupCamera() {
    try {
      this.cameraFunction();
    } catch (error) {
      this.log.error(`while happending CameraFunction ${error}`);
    }

    try {
      this.configureVideoStream();
    } catch (error) {
      this.log.error(`while happending Delegate ${error}`);
    }
  }

  private setupButtonService(
    serviceName: string,
    configValue: boolean | undefined,
    PropertyName: PropertyName,
    serviceType: 'switch' | 'lightbulb',
  ) {
    try {
      this.log.debug(`${serviceName} config:`, configValue);
      if (configValue && this.device.hasProperty(PropertyName)) {
        this.log.debug(`has a ${PropertyName}, so append ${serviceType}${serviceName} characteristic to it.`);
        this.setupSwitchService(serviceName, serviceType, PropertyName);
      } else {
        this.log.debug(`Looks like not compatible with ${PropertyName} or this has been disabled within configuration`);
      }
    } catch (error) {
      this.log.error(`raise error to check and attach ${serviceType}${serviceName}.`, error);
      throw error;
    }
  }

  protected setupSwitchService(
    serviceName: string,
    serviceType: 'switch' | 'lightbulb' | 'outlet',
    propertyName: PropertyName,
  ) {
    const platformServiceMapping = {
      switch: SERV.Switch,
      lightbulb: SERV.Lightbulb,
      outlet: SERV.Outlet,
    };

    this.registerCharacteristic({
      serviceType: platformServiceMapping[serviceType] || SERV.Switch,
      characteristicType: CHAR.On,
      name: this.accessory.displayName + ' ' + serviceName,
      serviceSubType: serviceName,
      getValue: (data, characteristic) => this.getCameraPropertyValue(characteristic, propertyName),
      setValue: (value, characteristic) => this.setCameraPropertyValue(characteristic, propertyName, value),
    });
  }

  private async setupEnableButton() {
    this.setupButtonService('Enabled', this.cameraConfig.enableButton, PropertyName.DeviceEnabled, 'switch');
  }

  private async setupMotionButton() {
    this.setupButtonService('Motion', this.cameraConfig.motionButton, PropertyName.DeviceMotionDetection, 'switch');
  }

  private async setupLightButton() {
    this.setupButtonService('Light', this.cameraConfig.lightButton, PropertyName.DeviceLight, 'lightbulb');
  }

  private async setupChimeButton() {
    this.setupButtonService('IndoorChime', this.cameraConfig.indoorChimeButton, PropertyName.DeviceChimeIndoor, 'switch');
  }

  /**
   * Get the configuration for a camera device.
   * 
   * - Combines default settings with those from the platform config.
   * - Validates certain settings like talkback capability.
   * 
   * @returns {CameraConfig} The finalized camera configuration.
   */
  private getCameraConfig(): CameraConfig {
    // Find the specific camera config from the platform based on its serial number
    const foundConfig = this.platform.config.cameras?.find(
      e => e.serialNumber === this.device.getSerial(),
    ) ?? {};

    // Garage cameras default virtual switches to off (camera + door are the primary features)
    const garageCameraDefaults: Partial<CameraConfig> = this.device.isGarageCamera()
      ? { enableButton: false, motionButton: false, lightButton: false }
      : {};

    // Combine default and specific configurations
    const config: Partial<CameraConfig> = {
      ...DEFAULT_CAMERACONFIG_VALUES,
      ...garageCameraDefaults,
      ...foundConfig,
      name: this.accessory.displayName,
    };

    // Initialize videoConfig if it's undefined
    if (!config.videoConfig) {
      config.videoConfig = {};
    }

    config.videoConfig!.debug = config.videoConfig?.debug ?? true;

    // Validate talkback setting
    if (config.talkback && !this.device.hasCommand(CommandName.DeviceStartTalkback)) {
      this.log.warn('Talkback for this device is not supported!');
      config.talkback = false;
    }

    // Validate talkback with rtsp setting
    if (config.talkback && config.rtsp) {
      this.log.warn('Talkback cannot be used with rtsp option. Ignoring talkback setting.');
      config.talkback = false;
    }

    this.log.debug(`config is`, config);

    return config as CameraConfig;
  }

  private cameraFunction() {

    // Fire snapshot when motion detected
    this.registerCharacteristic({
      serviceType: SERV.MotionSensor,
      characteristicType: CHAR.MotionDetected,
      name: this.accessory.displayName + ' Motion Sensor',
      serviceSubType: 'Motion Sensor',
      getValue: () => this.device.getPropertyValue(PropertyName.DeviceMotionDetected),
      onValue: (service, characteristic) => {
        this.eventTypesToHandle.forEach(eventType => {

          this.device.on(eventType as keyof any, (device: any, state: any) => {
            this.log.info(`MOTION DETECTED (${eventType})': ${state}`);
            characteristic.updateValue(state);
          });
        });
      },
    });

    // if (this.device.hasProperty('speaker')) {
    //   this.registerCharacteristic({
    //     serviceType: SERV.Speaker,
    //     characteristicType: CHAR.Mute,
    //     serviceSubType: 'speaker_mute',
    //     getValue: (data, characteristic) =>
    //       this.getCameraPropertyValue(characteristic, PropertyName.DeviceSpeaker),
    //     setValue: (value, characteristic) =>
    //       this.setCameraPropertyValue(characteristic, PropertyName.DeviceSpeaker, value),
    //   });
    // }

    // if (this.device.hasProperty('speakerVolume')) {
    //   this.registerCharacteristic({
    //     serviceType: SERV.Speaker,
    //     characteristicType: CHAR.Volume,
    //     serviceSubType: 'speaker_volume',
    //     getValue: (data, characteristic) =>
    //       this.getCameraPropertyValue(characteristic, PropertyName.DeviceSpeakerVolume),
    //     setValue: (value, characteristic) =>
    //       this.setCameraPropertyValue(characteristic, PropertyName.DeviceSpeakerVolume, value),
    //   });
    // }

    // if (this.device.hasProperty('microphone')) {
    //   this.registerCharacteristic({
    //     serviceType: SERV.Microphone,
    //     characteristicType: CHAR.Mute,
    //     serviceSubType: 'mic_mute',
    //     getValue: (data, characteristic) =>
    //       this.getCameraPropertyValue(characteristic, PropertyName.DeviceMicrophone),
    //     setValue: (value, characteristic) =>
    //       this.setCameraPropertyValue(characteristic, PropertyName.DeviceMicrophone, value),
    //   });
    // }

    if (this.device.isDoorbell()) {
      this.registerCharacteristic({
        serviceType: SERV.Doorbell,
        characteristicType: CHAR.ProgrammableSwitchEvent,
        onValue: (service, characteristic) => {
          this.device.on('rings', () => this.onDeviceRingsPushNotification(characteristic),
          );
        },
      });
    }

  }

  private async setupGarageDoorOpener() {
    const doors: (1 | 2)[] = [];

    if (this.cameraConfig.enableDoor1 && this.device.hasProperty(PropertyName.DeviceDoor1Open)) {
      doors.push(1);
    }
    if (this.cameraConfig.enableDoor2 && this.device.hasProperty(PropertyName.DeviceDoor2Open)) {
      doors.push(2);
    }

    if (doors.length === 0) {
      this.log.debug('No garage doors detected or all disabled in config');
      return;
    }

    for (const doorId of doors) {
      this.setupSingleGarageDoor(doorId);
    }

    // Listen for garage door status events on the station (not the device)
    try {
      const station = await this.platform.eufyClient.getStation(this.device.getStationSerial());
      station.on('garage door status', (_station: any, channel: number, doorId: number, status: number) => {
        const hkState = this.mapGarageDoorState(status);
        this.doorStates.set(doorId, hkState);
        this.log.debug(`Garage door ${doorId} status event: ${status} -> HomeKit state ${hkState}`);

        const chars = this.doorCharacteristics.get(doorId);
        if (chars) {
          chars.current.updateValue(hkState);
          chars.target.updateValue(this.targetFromCurrent(hkState));
        }
      });
    } catch (error) {
      this.log.warn(`Could not set up garage door station event listener: ${error}`);
    }
  }

  private setupSingleGarageDoor(doorId: 1 | 2) {
    const configName = doorId === 1 ? this.cameraConfig.door1Name : this.cameraConfig.door2Name;
    const doorName = configName || `Garage Door ${doorId}`;
    const subType = `Door ${doorId}`;

    this.log.debug(`Setting up garage door: ${doorName} (subType: ${subType})`);

    this.registerCharacteristic({
      serviceType: SERV.GarageDoorOpener,
      characteristicType: CHAR.CurrentDoorState,
      name: doorName,
      serviceSubType: subType,
      getValue: () => this.getDoorCurrentState(doorId),
      onValue: (_service, characteristic) => {
        this.doorCharacteristics.set(doorId, {
          current: characteristic,
          target: this.doorCharacteristics.get(doorId)?.target ?? characteristic,
        });
      },
    });

    this.registerCharacteristic({
      serviceType: SERV.GarageDoorOpener,
      characteristicType: CHAR.TargetDoorState,
      name: doorName,
      serviceSubType: subType,
      getValue: () => this.targetFromCurrent(this.getDoorCurrentState(doorId)),
      setValue: (value) => this.setDoorTargetState(doorId, value),
      onValue: (_service, characteristic) => {
        const existing = this.doorCharacteristics.get(doorId);
        this.doorCharacteristics.set(doorId, {
          current: existing?.current ?? characteristic,
          target: characteristic,
        });
      },
    });

    this.registerCharacteristic({
      serviceType: SERV.GarageDoorOpener,
      characteristicType: CHAR.ObstructionDetected,
      name: doorName,
      serviceSubType: subType,
      getValue: () => false,
    });

    this.setupDoorSensorBattery(doorId, doorName);
  }

  private setupDoorSensorBattery(doorId: 1 | 2, doorName: string) {
    const batteryLevelProp = doorId === 1
      ? PropertyName.DeviceDoorSensor1BatteryLevel
      : PropertyName.DeviceDoorSensor2BatteryLevel;
    const lowBatteryProp = doorId === 1
      ? PropertyName.DeviceDoorSensor1LowBattery
      : PropertyName.DeviceDoorSensor2LowBattery;

    if (!this.device.hasProperty(batteryLevelProp)) {
      this.log.debug(`Door ${doorId} sensor battery properties not available`);
      return;
    }

    const subType = `Door ${doorId} Battery`;
    const sensorName = `${doorName} Sensor`;

    this.registerCharacteristic({
      serviceType: SERV.Battery,
      characteristicType: CHAR.BatteryLevel,
      name: sensorName,
      serviceSubType: subType,
      getValue: () => this.device.getPropertyValue(batteryLevelProp) || 100,
    });

    if (this.device.hasProperty(lowBatteryProp)) {
      this.registerCharacteristic({
        serviceType: SERV.Battery,
        characteristicType: CHAR.StatusLowBattery,
        name: sensorName,
        serviceSubType: subType,
        getValue: () => {
          const isLow = this.device.getPropertyValue(lowBatteryProp);
          return isLow
            ? CHAR.StatusLowBattery.BATTERY_LEVEL_LOW
            : CHAR.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        },
      });
    }
  }

  private getDoorCurrentState(doorId: 1 | 2): number {
    if (this.doorStates.has(doorId)) {
      return this.doorStates.get(doorId)!;
    }
    const prop = doorId === 1 ? PropertyName.DeviceDoor1Open : PropertyName.DeviceDoor2Open;
    const doorOpen = this.device.getPropertyValue(prop);
    return doorOpen ? 0 : 1; // true=OPEN(0), false=CLOSED(1)
  }

  private async setDoorTargetState(doorId: number, state: CharacteristicValue) {
    try {
      const shouldOpen = state === 0;
      this.log.debug(`Setting door ${doorId} target state: ${shouldOpen ? 'Open' : 'Closed'}`);
      const station = await this.platform.eufyClient.getStation(this.device.getStationSerial());
      station.openDoor(this.device, shouldOpen, doorId);
    } catch (error) {
      this.log.error(`Door ${doorId} target state could not be set: ${error}`);
    }
  }

  private mapGarageDoorState(status: number): number {
    switch (status) {
      case GarageDoorState.A_OPENED:
      case GarageDoorState.B_OPENED:
        return 0; // OPEN
      case GarageDoorState.A_CLOSED:
      case GarageDoorState.B_CLOSED:
        return 1; // CLOSED
      case GarageDoorState.A_OPENING:
      case GarageDoorState.B_OPENING:
        return 2; // OPENING
      case GarageDoorState.A_CLOSING:
      case GarageDoorState.B_CLOSING:
        return 3; // CLOSING
      default: // NO_MOTOR, UNKNOWN
        return 4; // STOPPED
    }
  }

  private targetFromCurrent(currentState: number): number {
    switch (currentState) {
      case 0: // OPEN
      case 2: // OPENING
        return 0; // Target: OPEN
      case 1: // CLOSED
      case 3: // CLOSING
      default:
        return 1; // Target: CLOSED
    }
  }

  // This private function sets up the motion sensor characteristics for the accessory.
  private setupMotionFunction() {
    // Register the motion sensor characteristic for detecting motion.
    this.registerCharacteristic({
      serviceType: SERV.MotionSensor,
      characteristicType: CHAR.MotionDetected,
      name: this.accessory.displayName + ' Motion Sensor',
      serviceSubType: 'Motion Sensor',
      getValue: () => this.device.getPropertyValue(PropertyName.DeviceMotionDetected),
      onMultipleValue: this.eventTypesToHandle,
    });

    // If the camera is disabled, flag the motion sensor as tampered.
    // This is done because the motion sensor won't work until the camera is enabled again.
    this.registerCharacteristic({
      serviceType: SERV.MotionSensor,
      characteristicType: CHAR.StatusTampered,
      name: this.accessory.displayName + ' Motion Sensor',
      serviceSubType: 'Motion Sensor',
      getValue: () => {
        const tampered = this.device.getPropertyValue(PropertyName.DeviceEnabled);
        this.log.debug(`TAMPERED? ${!tampered}`);
        return tampered
          ? CHAR.StatusTampered.NOT_TAMPERED
          : CHAR.StatusTampered.TAMPERED;
      },
    });

    if (this.device.isDoorbell()) {
      this.registerCharacteristic({
        serviceType: SERV.Doorbell,
        characteristicType: CHAR.ProgrammableSwitchEvent,
        onValue: (service, characteristic) => {
          this.device.on('rings', () => this.onDeviceRingsPushNotification(characteristic),
          );
        },
      });
    }
  }

  protected getCameraPropertyValue(characteristic: any, propertyName: PropertyName): CharacteristicValue {
    try {
      const value = this.device.getPropertyValue(propertyName);
      return this.applyPropertyValue(characteristic, propertyName, value);
    } catch (error) {
      this.log.debug(`Error getting '${characteristic.displayName}' ${propertyName}: ${error}`);
      return false;
    }
  }

  protected applyPropertyValue(characteristic: any, propertyName: PropertyName, value: PropertyValue): CharacteristicValue {
    this.log.debug(`GET '${characteristic.displayName}' ${propertyName}: ${value}`);

    if (propertyName === PropertyName.DeviceNightvision) {
      return value === 1;
    }

    // Override for PropertyName.DeviceEnabled when enabled button is fired and 
    if (
      propertyName === PropertyName.DeviceEnabled &&
      Date.now() - this.cameraStatus.timestamp <= 60000
    ) {
      this.log.debug(`CACHED for (1 min) '${characteristic.displayName}' ${propertyName}: ${this.cameraStatus.isEnabled}`);
      value = this.cameraStatus.isEnabled;
    }

    if (characteristic.displayName === 'Manually Disabled') {
      value = !value;
      this.log.debug(`INVERSED '${characteristic.displayName}' ${propertyName}: ${value}`);
    }

    if (value === undefined) {
      throw new Error(`Value is undefined: this shouldn't happend`);
    }

    return value as CharacteristicValue;
  }

  protected async setCameraPropertyValue(characteristic: any, propertyName: PropertyName, value: CharacteristicValue) {
    try {
      this.log.debug(`SET '${characteristic.displayName}' ${propertyName}: ${value}`);
      await this.setPropertyValue(propertyName, value);

      if (
        propertyName === PropertyName.DeviceEnabled &&
        characteristic.displayName === 'On'
      ) {
        characteristic.updateValue(value);

        this.cameraStatus = { isEnabled: value as boolean, timestamp: Date.now() };
        characteristic = this.getService(SERV.CameraOperatingMode)
          .getCharacteristic(CHAR.ManuallyDisabled);

        this.log.debug(`INVERSED '${characteristic.displayName}' ${propertyName}: ${!value}`);
        value = !value as boolean;
      }

      characteristic.updateValue(value);
    } catch (error) {
      this.log.debug(`Error setting '${characteristic.displayName}' ${propertyName}: ${error}`);
    }
  }

  /**
   * Handle push notifications for a doorbell device.
   * Mute subsequent notifications within a timeout period.
   * @param characteristic - The Characteristic to update for HomeKit.
   */
  private onDeviceRingsPushNotification(characteristic: Characteristic): void {
    if (!this.notificationTimeout) {
      this.log.debug(`DoorBell ringing`);
      characteristic.updateValue(CHAR.ProgrammableSwitchEvent.SINGLE_PRESS);
      // Set a new timeout for muting subsequent notifications
      this.notificationTimeout = setTimeout(() => {
        this.notificationTimeout = null;
      }, 15 * 1000);
    }
  }

  // Get the current bitrate for a specific camera channel.
  public getBitrate(): number {
    return -1;
  }


  // Set the bitrate for a specific camera channel.
  public async setBitrate(): Promise<boolean> {
    return true;
  }

  // Configure a camera accessory for HomeKit.
  private configureVideoStream(): boolean {
    this.log.debug(`configureVideoStream`);

    try {
      this.log.debug(`StreamingDelegate`);
      this.streamingDelegate = new StreamingDelegate(this);

      this.log.debug(`RecordingDelegate`);
      this.recordingDelegate = new RecordingDelegate(
        this.platform,
        this.accessory,
        this.device,
        this.cameraConfig,
        this.streamingDelegate.getLivestreamManager(),
        this.streamingDelegate.getSnapshotDelegate(),
      );

      this.log.debug(`Controller`);
      const controller = new this.platform.api.hap.CameraController(this.getCameraControllerOptions());

      this.log.debug(`streamingDelegate.setController`);
      this.streamingDelegate.setController(controller);

      this.log.debug(`recordingDelegate.setController`);
      this.recordingDelegate.setController(controller);

      this.log.debug(`configureController`);

      // Remove stale controller-managed services from cache before configuring.
      // When HSV is enabled, CameraController creates CameraOperatingMode and
      // DataStreamTransportManagement services automatically. If the cached
      // accessory already has them (e.g. from a previous run), configureController
      // will throw a duplicate UUID error.
      const controllerManagedServiceUUIDs = [
        SERV.CameraOperatingMode.UUID,
        SERV.DataStreamTransportManagement.UUID,
      ];
      for (const uuid of controllerManagedServiceUUIDs) {
        const existingService = this.accessory.services.find(s => s.UUID === uuid);
        if (existingService) {
          this.log.debug(`Removing stale cached service ${uuid} before configureController`);
          this.accessory.removeService(existingService);
        }
      }

      this.accessory.configureController(controller);

    } catch (error) {
      this.log.error(`while happending Delegate ${error}`);
    }
    return true;
  }

  private getCameraControllerOptions(): CameraControllerOptions {

    const option: CameraControllerOptions = {
      cameraStreamCount: this.cameraConfig.videoConfig?.maxStreams || 2, // HomeKit requires at least 2 streams, but 1 is also just fine
      delegate: this.streamingDelegate as StreamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: this.resolutions,
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: this.cameraConfig.talkback,
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
          ],
        },
      },
      recording: {
        options: {
          overrideEventTriggerOptions: [
            EventTriggerOption.MOTION,
            EventTriggerOption.DOORBELL,
          ],
          prebufferLength: 0, // prebufferLength always remains 4s ?
          mediaContainerConfiguration: [
            {
              type: MediaContainerType.FRAGMENTED_MP4,
              fragmentLength: 4000,
            },
          ],
          video: {
            type: this.platform.api.hap.VideoCodecType.H264,
            parameters: {
              profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            },
            resolutions: this.resolutions,
          },
          audio: {
            codecs: {
              type: AudioRecordingCodecType.AAC_ELD,
              samplerate: AudioRecordingSamplerate.KHZ_24,
              bitrateMode: 0,
              audioChannels: 1,
            },
          },
        },
        delegate: this.recordingDelegate as RecordingDelegate,
      },
      sensors: {
        motion: this.getService(SERV.MotionSensor, this.accessory.displayName + ' Motion Sensor', 'Motion Sensor'),
        occupancy: undefined,
      },
    };

    return option;
  }

}