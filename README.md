# Fatigue Meter

A browser-based fingertip pulse scan for **brain fatigue** and **stress**. Cover the rear camera and flash of your phone with a fingertip for 60 seconds; the app extracts the pulse wave (photoplethysmogram, PPG), computes heart-rate variability (HRV) on the device and turns it into an age-adjusted fatigue level, a stress level, and a radar chart of how you felt. Nothing leaves the phone.

It is an open re-implementation inspired by the Japanese app *Hiromil – Fatigue and Stress Scan* (FMCC / Fatigue Science Research Institute). Hiromil uploads the pulse wave to a server and applies a patented, unpublished mapping; this project implements only the **published** science (age-corrected autonomic deviation values, published age regressions of HRV, the Fatigue Science Lab's LF/HF bands) and says so on its About page. It uses none of FMCC's algorithms or data.

**Fatigue Meter is a wellness indicator, not a medical device.** It does not diagnose, treat or prevent any disease. See the [disclaimer](#disclaimer).

## Running it

Requirements: Node 22 and npm.

```sh
npm install
npm run dev          # http://localhost:5173 (camera works on localhost)
npm run build        # typecheck + production build into dist/
npm run preview      # serve dist/ locally
npm test             # unit tests (vitest): DSP, scoring, storage
npm run test:e2e     # Playwright: synthetic tier + fake-camera tier (Chromium)
```

Other scripts: `npm run check` (typecheck + unit tests), `npm run typecheck:e2e` (types of the Playwright config and tests), `npm run test:e2e:synthetic` (fast tier only), `npm run test:e2e:camera` (real-time tier only).

`getUserMedia` needs a secure context. `localhost` counts, so the dev server works on the machine that runs it; a phone on the same Wi-Fi reaching `http://192.168.x.x:5173` does **not** get the camera. To test on a phone either deploy to GitHub Pages or open a tunnel.

## Testing on a phone

### GitHub Pages (recommended)

1. Push the repository to GitHub.
2. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions** (one-time).
3. Push to `main` (or run the *Deploy to GitHub Pages* workflow by hand). The workflow builds with `BASE_PATH=/<repository>/` and publishes `dist/`.
4. Open `https://<user>.github.io/fatigue-meter/` on the phone.

Test in a normal browser tab first. Then add it to the home screen and repeat: the manifest uses `display: minimal-ui` because iOS home-screen apps can lose the camera on in-app navigation, and the measurement screen deliberately never changes the URL while the camera is open.

### Tunnel (no deploy)

Any HTTPS tunnel to the dev server works, for example `npx localtunnel --port 5173`, `cloudflared tunnel --url http://localhost:5173` or ngrok. Open the HTTPS URL the tunnel prints on the phone.

### Browser support

| Browser | Camera | Flash (torch) | Exposure / focus lock | Notes |
| --- | --- | --- | --- | --- |
| Chrome / Edge on Android | yes | yes | yes (`exposureMode`, `focusMode`, `whiteBalanceMode: manual`) | Best signal. |
| Samsung Internet | yes | usually | partial | Depends on the device. |
| Safari on iOS 17.4+ (tab or home screen) | yes | yes | no | Torch via `applyConstraints`. On multi-lens iPhones the first measurement runs a lens scan (see below) because only the lens next to the flash is lit through the fingertip. |
| Safari on iOS < 17.4 | yes | no | no | Ambient-light mode: face a bright lamp or window so light shines through the fingertip (iOS refuses Control Centre flashlight while a page holds the camera). |
| Firefox on Android | yes | no | no | Ambient-light mode only. |
| Desktop browsers | webcam | no | no | Works for development; a webcam gives a weak signal. Use the demo in Settings. |

Without a torch the app falls back to **ambient mode**: it still looks for a red, pulsing fingertip but needs light coming through the finger (face a lamp or a window).

### Lens scan on multi-lens phones

The flash light has to pass through the fingertip into the lens, so only the lens next to the flash gets a usable signal: on an iPhone 14 Pro that is the telephoto, while a plain "rear camera" request returns the 1x main lens on the far side of the cluster. A web page cannot read the phone model, so the first camera measurement tries every physical rear lens once with the torch on (about 4 s per lens), scores the pulse each one sees (finger presence, pulse amplitude and periodicity), and remembers the winner by device id **and** label (iOS issues new ids on every page load). Right at the flash the image can be pink-white (red clipped), so the scan and the live detector score such a lens on its green or blue channel instead of discarding it. The measurement screen names the lens in use and has a **Switch lens** button while you place the finger, which cycles through the rear lenses and remembers the one you stop on. Settings always shows the detected lens (or "none yet"), lets you override it, has a "Detect the best lens again" button, and lists the last scan's per-lens scores with the reason each lens did or did not qualify. Keep one fingertip flat over the whole lens cluster and the flash while the scan runs.

### Frame clock and signal readout

Each camera frame carries several timestamps (`mediaTime`, `captureTime`, `presentationTime`); which one actually advances for a live camera stream differs between browsers, and iOS Safari has delivered a frozen `mediaTime`. The sampler watches the first frames and keeps the first clock that advances, so a frozen clock cannot zero every analysis window. The clock in use is stored with each measurement (Settings → Diagnostics). Turn on **Show signal details** in Settings to see a live line under the waveform with frames per second, the clock, samples and span of the analysed window, brightness level, pulse amplitude, periodicity and beat-template correlation; this is what to report when the app cannot find a pulse you can see.

### Measurement tips

- Sit down, rest the hand on a table, breathe normally and keep still for the whole minute.
- Cover the lens **and** the flash completely with the pad of a fingertip. Press lightly: too much pressure stops the blood flow and the signal disappears.
- Warm the hands first if they are cold.
- Measure under the same conditions each time (same time of day, before coffee, after sitting quietly for a minute) so results are comparable.
- A 60-second scan is a snapshot. If two consecutive results differ a lot, repeat and look at the median.

## How it works

### Pipeline (`src/capture`, `src/dsp`)

1. **Capture.** The rear camera streams at ~30 fps (ideal 320×240) with the torch on where supported. Each frame's centre crop (50 % per axis, downscaled to 32×32) gives one sample: mean R, G, B and the fraction of saturated pixels, timestamped from `requestVideoFrameCallback` (one time base per session). The finger detector checks colour ratios (torch mode: R/(R+G+B) ≥ 0.40, R/G ≥ 1.5, 60 ≤ R ≤ 254; ambient mode: ratio ≥ 0.33, R > G > B, luminance 15–240) and stability; the recording clock starts after 2 s of stable, good-quality signal, and exposure/focus/white balance are locked once the signal is stable.
2. **Resampling.** The jittered samples are interpolated by a natural cubic spline onto a uniform 60 Hz grid; dropped frames and gaps are counted.
3. **Channel.** Green by default (best signal-to-noise, rarely saturates); red when green is too dark or its pulse is weak while red is unsaturated. The signal is inverted so a systole points up.
4. **Filtering.** Runtime-designed 2nd-order Butterworth biquads, applied forward–backward (zero phase): 0.5–8 Hz for peak detection, 0.5–4 Hz for the displayed waveform.
5. **Peaks.** Elgendi's systolic-peak detector with the NeuroKit2 parameters (squared clipped signal, moving averages of 0.111 s and 0.667 s, offset 0.02, refractory 0.3 s) and parabolic sub-sample refinement, which removes the ~10 ms quantisation floor of 30 fps.
6. **Intervals.** Beat-to-beat (NN) intervals must lie in 300–2000 ms and within ±25 % of the 5-neighbour local median; rejected intervals are masked, never interpolated.
7. **HRV.** Time domain: mean NN, heart rate, SDNN, RMSSD, ln RMSSD, pNN50, CVNN, SD1/SD2. Frequency domain: Lomb–Scargle periodogram of the unevenly spaced NN series (linear detrend, oversampling 4), LF = 0.04–0.15 Hz, HF = 0.15–0.40 Hz, TP = LF + HF (VLF is not resolvable in a minute), LF/HF, normalised units, the number of independent LF cells, and a respiration estimate (dominant peak in 0.1–0.5 Hz).
8. **Quality.** Each 10-s segment passes an Orphanidou-style check (HR 40–180, no gap > 3 s, longest/shortest interval ≤ 2.2, beat-template correlation ≥ 0.86); perfusion, skewness and periodicity are recorded too.

### Quality policy

| Verdict | Conditions |
| --- | --- |
| **FULL** | ≥ 40 accepted NN intervals, accepted fraction ≥ 0.95, no gap > 3 s, dropped/interpolated frames ≤ 10 %, good-signal time ≥ 50 of 60 s |
| **TIME_DOMAIN_ONLY** | accepted fraction 0.90–0.95 with everything else satisfied; no spectral scores |
| **FAIL** | anything else; the app explains why and asks for another attempt |

### Scoring (`src/scoring`)

All norms are natural-log means with one standard deviation, evaluated at the user's age (clamped to 20–75 years; flagged as extrapolated outside 20–70). Only the **birth year** is required; sex is optional and affects only the stress deviation value.

| Quantity | Norm (age in years) | σ | Source |
| --- | --- | --- | --- |
| ln HF (ms²) | 6.833 − 0.039·age | 0.90 | Choi et al. 2020 (fingertip PPG, 300 seated adults, no sex difference) |
| ln LF (ms²) | 7.197 − 0.047·age | 0.80 | Choi et al. 2020 |
| ln (LF + HF) | ln(e^{μ_lnLF} + e^{μ_lnHF}) ≈ 7.71 − 0.043·age | 0.80 | derived from the two above |
| ln RMSSD (ms) | 4.0 − 0.012·age | 0.45 | placeholder informed by Nunan et al. 2010 (low confidence) |
| ln (LF/HF) | men 0.60 + 0.013·(age − 30); women 0.15 + 0.013·(age − 30); unspecified: midpoint | 0.90 | derived from Voss et al. 2015 (low confidence) |

**Autonomic activity.** A z-score is turned into a deviation value *T* = 50 + 10·z, clamped to 20–80 (50 = average for your age, 10 = one SD).

- 60-second scan (default): z = mean( z(ln HF), z(ln RMSSD) ) — the two quantities a minute measures reliably.
- ≥ 90-second scan of FULL quality (120-s "precise" mode in Settings): z = z(ln (LF + HF)), the Okawa 2019 age-corrected deviation value.

**Brain fatigue = 100 − T**, so a higher number means more fatigue. Levels from *T*: ≥ 58 → 1 (very low), 50–58 → 2 (low), 42–50 → 3 (average), 37–42 → 4 (elevated / caution), < 37 → 5 (high / warning). The 42 and 37 cut points are the Fatigue Science Lab's published caution and warning bands. An optional *autonomic age* = (7.71 − ln (LF + HF)) / 0.043, clamped to 20–80, is shown with the details.

**Stress.** The sympathetic/parasympathetic balance LF/HF in five age-independent bands: < 0.8 → 1 (relaxed), 0.8–2.0 → 2 (normal), 2.0–3.5 → 3 (mildly elevated), 3.5–5.0 → 4 (elevated), ≥ 5.0 → 5 (high). An age- and sex-adjusted stress deviation value from ln (LF/HF) is stored and can be shown from Settings.

**The 60-second caveat.** One minute resolves only a handful of independent spectral cells in the LF band (T × bandwidth ≈ 6.6), so LF and LF/HF from a 60-s recording are noisy. The stress level therefore carries a **provisional** badge when the recording is shorter than 90 s, has fewer than 5 LF cells, a heart rate below 48 bpm, or a respiratory peak below 0.15 Hz (slow breathing pushes respiratory power into the LF band). With a TIME_DOMAIN_ONLY verdict no stress level is shown at all. The 120-s precise mode is the measurement length the method's research group uses clinically.

**Personal baseline.** The population norms are 5-minute literature values applied to 60-second measurements; they are a reference, not a truth. After **30 valid measurements** the comments compare each new result with the user's own mean ± SD of *T* instead of the population, and the app suggests repeating and using the median when consecutive results differ by more than 10 *T* points.

**Subjective scale.** Five visual-analogue sliders (energy, relaxation, activity, motivation, sleep; 0–100) and the bedtime/wake time are shown as a pentagon radar with the previous measurement overlaid. They are not part of the physiological scores.

### Sources

- Choi J. et al. (2020). Age and sex differences in HRV measured with fingertip PPG in 300 adults. *Front Aging Neurosci* 12:610626.
- Voss A. et al. (2015). Short-term heart rate variability: influence of gender and age in healthy subjects. *PLoS ONE* 10:e0118308.
- Nunan D. et al. (2010). A quantitative systematic review of normal values for short-term heart rate variability in healthy adults. *PACE* 33:1407–1417.
- Okawa N. et al. (2019). Age-corrected autonomic deviation values for fatigue assessment.
- Elgendi M. et al. (2013). Systolic peak detection in acceleration photoplethysmograms measured from emergency responders in tropical conditions. *PLoS ONE* 8:e76585.
- Orphanidou C. et al. (2015). Signal-quality indices for the electrocardiogram and photoplethysmogram. *IEEE J Biomed Health Inform* 19:832–838.
- Task Force of the ESC and NASPE (1996). Heart rate variability: standards of measurement, physiological interpretation and clinical use. *Circulation* 93:1043–1065.
- Fatigue Science Laboratory (Fatigue Science Research Institute / Kuratsune H.), published autonomic-activity caution and warning bands and LF/HF stress bands.

## Privacy

Everything runs in the browser. Camera frames are reduced to colour means on the device and never stored as images; measurements, the profile (birth year, optional sex) and settings live in the browser's IndexedDB on that phone. There is no account, no analytics and no network request other than loading the app itself. **History → Export JSON** writes everything (including the raw pulse samples when *keep raw data* is on) to a file you control; **Import JSON** restores it on another device; **Delete all** wipes the database.

## Project layout

```
index.html, src/main.ts, src/styles.css   app shell, service-worker registration (update prompt only on the home screen)
src/strings.ts                            every user-facing string (ready for translation)
src/app/                                  hash router, session state, test ids, screens/ (home, profile, vas, sleep, measure, result, history, settings, about)
src/capture/                              SampleSource contract, camera source (getUserMedia, torch, locks, wake lock), frame sampler, finger detection, synthetic demo source, thresholds (config.ts)
src/dsp/                                  sample types, synthetic generator, filters, spline resampling, Elgendi peaks, NN cleaning, HRV time/frequency, quality, pipeline
src/scoring/                              norms (versioned, with provenance), scores, VAS/sleep helpers, comments
src/storage/                              IndexedDB (records, summaries, profile, settings, export/import)
src/ui/                                   waveform, gauge, radar, slider, DOM helpers
tests/dsp, tests/scoring, tests/storage   vitest unit tests (fake-indexeddb for storage)
tests/e2e/                                Playwright: synthetic.spec.ts (fake clock), measure.spec.ts (fake camera), y4m.ts + global-setup.ts (video fixture)
.github/workflows/                        ci.yml (typecheck, unit, build, e2e), deploy.yml (GitHub Pages)
```

### Tests

- **Unit** (`npm test`): biquad coefficients against a verified table, spline exactness, beat-count and beat-time error of the detector on the synthetic pulse at 30 fps, NN cleaning on injected ectopic/missed beats, HRV against the generator's closed-form expectations, Lomb–Scargle power conservation and a 4 Hz-FFT cross-check, the quality gate on a poor-signal preset, score cut points, comment matrix, database round-trip.
- **E2E, synthetic tier** (`npm run test:e2e:synthetic`, seconds): the full UI flow with `#/measure?source=synthetic&seed=42` under Playwright's fake clock.
- **E2E, camera tier** (`npm run test:e2e:camera`, about 90 s): the real camera code path. Global setup renders the synthetic pulse as a 64×48 Y4M video (`tests/e2e/.cache/finger.y4m`; uniform colour per frame with the red channel following the pulse), which Chromium's `--use-file-for-fake-video-capture` plays as a camera. Torch and lock requests are rejected by the fake device, as on many real phones. The test asserts the measured heart rate within ±3 bpm of the encoded 66.7 bpm.

Every e2e run builds the app and serves `dist/` with `vite preview` on `127.0.0.1:4173`, unless something is already listening there: locally Playwright reuses that server as-is (so stop any stale `npm run preview` first, or the tests exercise an outdated `dist/`); with `CI` set, reuse is disabled and an occupied port is an error. The fake-camera Y4M fixture is re-rendered by the global setup on every run (it takes well under a second), so it can never lag behind the generator.

## Disclaimer

Fatigue Meter is a wellness and self-observation tool. It is **not a medical device**; it does not diagnose, treat, cure or prevent any disease, and its scores are not a substitute for professional medical advice. The norms are population averages from the literature and are approximate; irregular heart rhythms, pacemakers, some medications, caffeine, posture and breathing all change HRV in ways the scores do not account for. If you feel unwell, have chest pain, palpitations or persistent fatigue, consult a clinician.
