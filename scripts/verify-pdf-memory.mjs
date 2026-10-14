import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const root = resolve('.'),
  profile = await mkdtemp(join(root, '.cache', 'pdf-memory-'));
const packaged = process.argv[2],
  app = await electron.launch({
    executablePath: resolve(packaged || 'node_modules/electron/dist/electron.exe'),
    args: packaged ? [] : [root],
    env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
    timeout: 60000,
  });
const report = {
  kind: 'process-memory-snapshot',
  modelsLoaded: false,
  snapshots: [],
  limits:
    'Single observations, not an energy benchmark. Working sets include shared pages and must not be treated as unique physical RAM. No forced GC.',
};
try {
  const page = await app.firstWindow();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const sample = async (name) => {
    await page.waitForTimeout(800);
    report.snapshots.push({
      name,
      processes: await app.evaluate(({ app }) =>
        app.getAppMetrics().map((p) => ({ type: p.type, memory: p.memory })),
      ),
      heap: await page.evaluate(() =>
        performance.memory
          ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize }
          : null,
      ),
    });
  };
  await sample('fresh-blank');
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 8; i++)
    d.addPage([600, 800]).drawText('Memory fixture ' + i, { x: 40, y: 700, font, size: 24 });
  const bytes = Buffer.from(await d.save());
  for (let n = 0; n < 3; n++) {
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: `memory-${n}.pdf`, mimeType: 'application/pdf', buffer: bytes });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    for (let i = 1; i <= 8; i++) {
      await page.getByRole('button', { name: `第 ${i} 页`, exact: true }).click();
      await expect(page.locator('.pdf-layer')).toHaveAttribute('data-rendered-night', 'false');
    }
    await sample(`document-${n + 1}-eight-pages`);
  }
  await writeFile(
    join(root, '.cache', 'pdf-memory-processes.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
