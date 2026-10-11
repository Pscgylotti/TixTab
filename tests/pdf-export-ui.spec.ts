import { test } from '@playwright/test';
import { verifyPdfUi } from '../scripts/verify-pdf-ui.mjs';
test('actual UI export retains document structures and gates modified signed copies in both languages', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await verifyPdfUi(page);
});
