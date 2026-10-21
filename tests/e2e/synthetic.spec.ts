/**
 * Fast tier: the whole flow through the UI, with the measurement taken from
 * the timer-driven synthetic source under Playwright's fake clock, so a
 * 60-second recording completes in a few seconds and is bit-identical on
 * every run (seed 42).
 */
import { expect, test, type Page } from '@playwright/test';
import { TID } from '../../src/app/testids';

const BIRTH_YEAR = '1985';
const VAS_VALUE = '60';
const RESULT_URL = /#\/result\//;

/**
 * The fake clock is pinned so the age-normed fatigue level cannot drift with
 * the calendar: with birth year 1985 the user is 41 at this date. (T rises
 * about 0.35 per year of age for this pulse; on the real clock the expected
 * level would flip from 2 to 1 in 2042.)
 */
const CLOCK_DATE = new Date('2026-01-15T09:00:00');

/**
 * Exact expectations for seed 42, birth year 1985 at CLOCK_DATE. Derived by
 * running generateSynthetic({ seed: 42, fps: 30, durationS: 140 }) through
 * analyzePPG with a 60-s window and scoreMeasurement (sex unspecified), as
 * measure.ts does, for every window start from 2 s to 15 s in 0.1-s steps
 * (the UI starts the window at about 5–7 s, after the settle gate): verdict
 * 'full' every time; brain fatigue 47.1–48.0 (T 52.0–52.9, basis
 * lnHF+lnRMSSD) → fatigue level 2; LF/HF 0.44–0.49 → stress level 1,
 * provisional because 60 s < 90 s; heart rate 66.7 bpm. An intentional DSP
 * or norms change that moves these values is updated here deliberately.
 */
const EXPECTED_FATIGUE_LEVEL = '2';
const EXPECTED_STRESS_LEVEL = '1';
const EXPECTED_FATIGUE_SCORE = { min: 46, max: 49 };

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

test('synthetic source: a full measurement under a fake clock produces a scored result', async ({ page }) => {
  // Installed before navigation so the app's timers and performance.now() are fake from the start.
  await page.clock.install({ time: CLOCK_DATE });

  await walkToMeasure(page);
  await page.goto('/#/measure?source=synthetic&seed=42');
  await page.getByTestId(TID.measureStart).click();

  // 2 s settle + 60 s window + 2 s filter padding, plus the warm-up before the
  // first live heart rate; each step lets the 33 ms sample timer and the 250 ms
  // screen tick fire in order.
  for (let i = 0; i < 80; i++) await page.clock.runFor(1000);

  await expect
    .poll(
      async () => {
        await page.clock.runFor(1000);
        return urlOrMeasureError(page);
      },
      { timeout: 60_000, message: 'measurement did not reach the result screen' },
    )
    .toMatch(RESULT_URL);

  await expect(page.getByTestId(TID.resultFatigueLevel)).toHaveText(EXPECTED_FATIGUE_LEVEL);
  await expect(page.getByTestId(TID.resultStressLevel)).toHaveText(EXPECTED_STRESS_LEVEL);
  await expect(page.getByTestId(TID.resultProvisional)).toBeVisible();
  const score = Number(await page.getByTestId(TID.resultFatigueScore).textContent());
  expect(score, 'brain fatigue score for seed 42').toBeGreaterThanOrEqual(EXPECTED_FATIGUE_SCORE.min);
  expect(score).toBeLessThanOrEqual(EXPECTED_FATIGUE_SCORE.max);
  await expect(page.getByTestId(TID.resultRadar)).toBeVisible();

  await page.goto('/#/history');
  await expect(page.getByTestId(TID.historyItem)).toHaveCount(1);
});
