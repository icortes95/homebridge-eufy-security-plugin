export const DEFAULT_CONFIG_VALUES = {
  enableDetailedLogging: false,
  CameraMaxLivestreamDuration: 30,
  pollingIntervalMinutes: 10,
  hkHome: 1,
  hkAway: 0,
  hkNight: 3,
  hkOff: 63,
  ignoreStations: [],
  ignoreDevices: [],
  country: 'US',
  cameras: [],
  cleanCache: true,
  unbridge: true,
};

export const DEFAULT_CAMERACONFIG_VALUES = {
  enableButton: true,
  motionButton: true,
  rtsp: false,
  enableCamera: false,
  forcerefreshsnap: false,
  useCachedLocalLivestream: false,
  useEnhancedSnapshotBehaviour: true,
  refreshSnapshotIntervalMinutes: 0,
  snapshotHandlingMethod: 3,
  immediateRingNotificationWithoutSnapshot: false,
  delayCameraSnapshot: false,
};