/**
 * Real-time tier: the whole flow through the UI with the real camera code
 * path. Chromium's fake camera plays tests/e2e/.cache/finger.y4m (rendered
 * from the synthetic pulse by global-setup.ts) at 30 fps, so getUserMedia,
 * the frame sampler, finger detection and the analysis run as on a phone.
 * Torch and exposure-lock requests are rejected by the fake device, which
 * the app must tolerate. Takes a little over a minute.
 */
import { expect, test, type Page } from '@playwright/test';
import { TID } from '../../src/app/testids';
import { FIXTURE_HR_BPM } from './y4m';

test.describe.configure({ timeout: 180_000 });

const BIRTH_YEAR = '1985';
const VAS_VALUE = '60';
const RESULT_URL = /#\/result\//;
const LEVEL = /^[1-5]$/;
// The stress gauge prints an empty level when the spectrum was not reliable.
const LEVEL_OR_NONE = /^(?:[1-5]|—|Not available)?$/;
const HR_TOLERANCE_BPM = 3;

/** Home → profile (first run only) → five VAS questions → sleep times → measure. */
async function walkToMeasure(page: Page): Promise<void> {
  await page.goto('/#/home');
  await page.getByTestId(TID.homeStart).click();

  const birthYear = page.getByTestId(TID.profileBirthYear);
  const firstSlider = page.getByTestId(TID.vasSlider(0));
  await expect(birthYear.or(firstSlider)).toBeVisible();
  if (await birthYear.isVisible()) {
    await birthYear.fill(BIRTH_YEAR);
    await page.getByTestId(TID.profileAccept).check();
    await page.getByTestId(TID.profileSave).click();
    // Saving may continue to the questionnaire or return to the home screen.
    await expect(firstSlider.or(page.getByTestId(TID.homeStart))).toBeVisible();
    if (!(await firstSlider.isVisible())) await page.getByTestId(TID.homeStart).click();
  }
  await expect(page).toHaveURL(/#\/vas/);

  for (let i = 0; i < 5; i++) {
    const slider = page.getByTestId(TID.vasSlider(i));
    await expect(slider).toBeVisible();
    // fill() sets the value of a range input and fires input + change.
    await slider.fill(VAS_VALUE);
    await slider.dispatchEvent('input');
    await slider.dispatchEvent('change');
    const next = page.getByTestId(TID.vasNext);
    if (await next.isDisabled()) {
      // Fallback: a keyboard nudge also counts as answering the question.
      await slider.focus();
      await page.keyboard.press('ArrowRight');
    }
    await expect(next).toBeEnabled();
    await next.click();
  }

  await expect(page).toHaveURL(/#\/sleep/);
  await page.getByTestId(TID.sleepBed).fill('23:30');
  await page.getByTestId(TID.sleepWake).fill('06:45');
  await page.getByTestId(TID.sleepNext).click();
  await expect(page).toHaveURL(/#\/measure/);
}

/** Fails fast with the on-screen message if the measurement errors out instead of finishing. */
async function urlOrMeasureError(page: Page): Promise<string> {
  const error = page.getByTestId(TID.measureError);
  if (await error.isVisible()) throw new Error(`measurement failed: ${(await error.innerText()).trim()}`);
  return page.url();
}

/** First number in the element's text (e.g. "67" from "67 bpm"). */
function firstNumber(text: string | null): number {
  const m = /-?\d+(?:[.,]\d+)?/.exec(text ?? '');
  return m ? Number.parseFloat(m[0].replace(',', '.')) : Number.NaN;
}

test('fake camera: a real-time measurement reports the heart rate encoded in the video', async ({ page }) => {
  await walkToMeasure(page);
  await page.getByTestId(TID.measureStart).click();

  // Camera start, ~5 s of warm-up and settling, 60 s window, 2 s padding, analysis.
  await expect
    .poll(() => urlOrMeasureError(page), {
      timeout: 150_000,
      intervals: [1000],
      message: 'measurement did not reach the result screen',
    })
    .toMatch(RESULT_URL);

  await expect(page.getByTestId(TID.resultFatigueLevel)).toHaveText(LEVEL);
  await expect(page.getByTestId(TID.resultStressLevel)).toHaveText(LEVEL_OR_NONE);

  const hr = firstNumber(await page.getByTestId(TID.resultHr).textContent());
  expect(hr, `heart rate ${hr} should be within ±${HR_TOLERANCE_BPM} bpm of ${FIXTURE_HR_BPM.toFixed(1)}`).toBeGreaterThanOrEqual(
    FIXTURE_HR_BPM - HR_TOLERANCE_BPM,
  );
  expect(hr).toBeLessThanOrEqual(FIXTURE_HR_BPM + HR_TOLERANCE_BPM);

  await page.goto('/#/history');
  await expect(page.getByTestId(TID.historyItem)).toHaveCount(1);
});
