import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const folder = new URL('./', import.meta.url);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1.5,
  });
  await page.goto(new URL('preview.html', folder).href);
  await page.evaluate(() => document.fonts.ready);
  const broken = await page
    .locator('img')
    .evaluateAll((images) =>
      images.filter((img) => !img.complete || !img.naturalWidth).map((img) => img.src),
    );
  assert.deepEqual(broken, [], 'All preview images must load');
  await page.screenshot({ path: fileURLToPath(new URL('preview.png', folder)), fullPage: true });
  for (const name of ['tixtab-paper.svg', 'tixtab-ink.svg', 'tixtab-ink-glyph.svg']) {
    const source = await readFile(new URL(name, folder), 'utf8');
    const valid = await page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      return (
        !doc.querySelector('parsererror, script, image, foreignObject, text') &&
        doc.documentElement.localName === 'svg' &&
        !source.includes('href=')
      );
    }, source);
    assert.ok(valid, `${name} must be valid standalone vector artwork`);
  }
  console.log(
    'Preview exported; all images load; final SVGs are valid, contain no bitmap, script, font, or external reference.',
  );
} finally {
  await browser.close();
}
