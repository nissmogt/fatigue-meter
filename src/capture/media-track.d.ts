/**
 * Image-capture constraints (W3C mediacapture-image) that TypeScript's DOM lib
 * does not yet declare on capabilities/constraint sets. Chrome on Android
 * implements them; other browsers ignore or reject them.
 */
interface MediaSettingsRange {
  max?: number;
  min?: number;
  step?: number;
}

interface MediaTrackCapabilities {
  torch?: boolean;
  exposureMode?: string[];
  exposureTime?: MediaSettingsRange;
  exposureCompensation?: MediaSettingsRange;
  focusMode?: string[];
  focusDistance?: MediaSettingsRange;
  whiteBalanceMode?: string[];
  iso?: MediaSettingsRange;
  zoom?: MediaSettingsRange;
}

interface MediaTrackConstraintSet {
  torch?: boolean;
  exposureMode?: string;
  exposureTime?: number;
  exposureCompensation?: number;
  focusMode?: string;
  focusDistance?: number;
  whiteBalanceMode?: string;
  iso?: number;
  zoom?: number;
}

interface MediaTrackSettings {
  exposureMode?: string;
  exposureTime?: number;
  focusMode?: string;
  focusDistance?: number;
  iso?: number;
}

interface MediaTrackSupportedConstraints {
  torch?: boolean;
  exposureMode?: boolean;
  focusMode?: boolean;
  whiteBalanceMode?: boolean;
}
