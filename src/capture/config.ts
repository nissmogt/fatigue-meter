/**
 * Every capture-side threshold in one place. The finger detector, the frame
 * sampler and the camera source read from here; nothing else defines these
 * numbers. Colour values are 8-bit channel means of the centre crop.
 */

// --- Finger presence, torch mode (the flash lights the fingertip from inside) --
/** Minimum r/(r+g+b): a transilluminated fingertip is strongly red. */
export const TORCH_RED_RATIO_MIN = 0.4;
/** Mean red below this means too little light reaches the sensor. */
export const TORCH_RED_MIN = 60;
/** Mean red above this means the sensor is clipping (press lighter). */
export const TORCH_RED_MAX = 254;
/** Minimum red/green ratio with the torch on. */
export const TORCH_RG_RATIO_MIN = 1.5;

// --- Finger presence, ambient mode (no torch, room light through the finger) --
/** Minimum r/(r+g+b) without the torch (less red than with the flash). */
export const AMBIENT_RED_RATIO_MIN = 0.33;
/** Luminance (0.299r + 0.587g + 0.114b) below this is too dark to measure. */
export const AMBIENT_LUMA_MIN = 15;
/** Luminance above this is too bright (uncovered lens in daylight). */
export const AMBIENT_LUMA_MAX = 240;

// --- Saturation ---------------------------------------------------------------
/** A pixel whose red value is at or above this counts as saturated. */
export const SATURATION_LEVEL = 250;
/** Fraction of saturated crop pixels at which a frame counts as saturated. */
export const SATURATED_FRACTION_MAX = 0.5;

// --- Stability (finger still, pressure constant) ------------------------------
/** Seconds of recent samples the stability check looks at. */
export const STABLE_WINDOW_S = 2;
/** Max change (levels) between the means of two consecutive 1-s halves. */
export const STABLE_MEAN_DELTA_MAX = 10;
/** Max frame-to-frame jump (levels); larger is a DC step (finger moved). */
export const STABLE_STEP_MAX = 10;

// --- Frame delivery -------------------------------------------------------------
/**
 * Delivered frames per second below which the measurement is aborted. The DSP
 * spline-upsamples from the measured source rate, so a steady 12–20 fps (what
 * Chrome on Android delivers in a dark, torch-less scene: it picks the AE fps
 * range with the lowest minimum) still scores accurately; below about 12 fps
 * beat timing degrades (RMSSD error > 10 %, > 40 % at 8 fps), so that aborts.
 */
export const LOW_FPS_LIMIT = 12;
/** Seconds over which delivered fps is measured. */
export const LOW_FPS_WINDOW_S = 2;
/** Seconds after start before the low-fps rule is enforced (camera warm-up). */
export const LOW_FPS_GRACE_S = 3;

// --- Sampler geometry ------------------------------------------------------------
/** Fraction of videoWidth/videoHeight (per axis) kept as the centre crop. */
export const CROP_FRACTION = 0.5;
/** Side of the square analysis canvas in pixels (32 × 32 = 1024 pixels averaged). */
export const GRID_SIZE = 32;

// --- Torch verification ------------------------------------------------------------
/** Milliseconds to wait after torch:true before judging the brightness change. */
export const TORCH_VERIFY_DELAY_MS = 300;
/** Milliseconds of frames gathered after the delay to compute the new brightness. */
export const TORCH_VERIFY_SAMPLE_MS = 300;
/** Seconds of frames before the request that form the brightness baseline. */
export const TORCH_VERIFY_BASELINE_S = 0.5;
/** Mean-red rise (levels) that confirms the torch really switched on. */
export const TORCH_VERIFY_MIN_RISE = 8;

// --- Camera defaults -----------------------------------------------------------------
/** Ideal capture size; small frames keep per-frame work and exposure stable. */
export const IDEAL_WIDTH = 320;
export const IDEAL_HEIGHT = 240;
/** Ideal frame rate; 60 fps would only halve the exposure time. */
export const IDEAL_FPS = 30;
/** Milliseconds allowed for the first frame to arrive after getUserMedia. */
export const START_TIMEOUT_MS = 5000;
/** Seconds of recent samples the camera source keeps for torch verification. */
export const RECENT_SAMPLES_S = 3;
