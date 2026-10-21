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
const LEVEL = /^[1-5]$/;
// The stress gauge prints an empty level when the spectrum was not reliable.
const LEVEL_OR_NONE = /^(?:[1-5]|—|Not available)?$/;

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
  await page.clock.install();

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

  await expect(page.getByTestId(TID.resultFatigueLevel)).toHaveText(LEVEL);
  await expect(page.getByTestId(TID.resultStressLevel)).toHaveText(LEVEL_OR_NONE);
  await expect(page.getByTestId(TID.resultRadar)).toBeVisible();

  await page.goto('/#/history');
  await expect(page.getByTestId(TID.historyItem)).toHaveCount(1);
});
