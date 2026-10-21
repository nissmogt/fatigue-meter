/** Public surface of the capture layer. */
export { createCameraSource, listCameras } from './camera';
export { createSyntheticSource, SYNTHETIC_DEFAULT_DURATION_S, SYNTHETIC_DEFAULT_FPS } from './synthetic';
export { createSampler } from './sampler';
export type { FrameLoop, Sampler, SamplerOptions, TimeBase } from './sampler';
export * from './finger';
export * from './config';
export * from './source';
