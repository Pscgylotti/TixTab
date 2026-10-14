import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const folder = new URL('./', import.meta.url);
await mkdir(new URL('previews/', folder), { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });
  await page.goto('http://127.0.0.1:5191', { waitUntil: 'domcontentloaded' });
  await page.locator('.brand').waitFor({ timeout: 60000 });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.screenshot({ path: fileURLToPath(new URL('previews/gui-reference.png', folder)) });
  for (const [name, file] of [
    ['ink', 'tixtab-ink.svg'],
    ['paper', 'tixtab-paper.svg'],
  ]) {
    const svg = await readFile(new URL(file, folder), 'utf8');
    for (const mode of ['light', 'dark']) {
      await page.evaluate(
        ({ svg, mode }) => {
          document.documentElement.dataset.night = String(mode === 'dark');
          const mark = document.querySelector('.brand-mark');
          mark.style.background = 'transparent';
          mark.innerHTML = svg;
          mark.firstElementChild.style.width = '30px';
          mark.firstElementChild.style.height = '30px';
        },
        { svg, mode },
      );
      await page.screenshot({
        path: fileURLToPath(new URL(`previews/${name}-header-${mode}.png`, folder)),
        clip: { x: 0, y: 0, width: 830, height: 145 },
      });
    }
  }
  console.log(
    'Captured real GUI palette, plus temporary light/dark icon placement previews. Application source unchanged.',
  );
} finally {
  await browser.close();
}
