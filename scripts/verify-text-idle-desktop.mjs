import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const app = await electron.launch({
  executablePath: resolve(process.argv[2]),
  env: {
    ...process.env,
    SURFACETAB_PROFILE: await mkdtemp(join(tmpdir(), 'tixtab-text-')),
    SURFACETAB_DEV: '0',
  },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.paper').waitFor();
  assert.equal(await page.title(), 'TixTab · Thinking over Screen');
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await page.locator('.paper').click({ position: { x: 160, y: 180 } });
  await app.evaluate(({ clipboard }) => clipboard.writeText('Native clipboard\n真实粘贴'));
  await page.keyboard.press('Control+v');
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(1);
  await expect(page.locator('.placed-object img')).toHaveAttribute(
    'alt',
    'Native clipboard\n真实粘贴',
  );
  await page.getByRole('button', { name: '编辑选中文本框', exact: true }).click();
  const field = page.getByLabel('文本框内容', { exact: true });
  await field.focus();
  await field.press('Control+a');
  await app.evaluate(({ clipboard }) => clipboard.writeText('Ordinary field paste'));
  await page.keyboard.press('Control+v');
  await expect(field).toHaveValue('Ordinary field paste');
  await page.getByRole('button', { name: '保存文本框', exact: true }).click();
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 64, 48);
    return canvas.toDataURL().split(',')[1];
  });
  await app.evaluate(async ({ clipboard, ClipboardItem }, base64) => {
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }),
      }),
    ]);
  }, base64);
  await page.evaluate(() => {
    window.addEventListener(
      'paste',
      (event) => {
        window.__pasteDebug = {
          types: [...event.clipboardData.types],
          files: [...event.clipboardData.files].map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
          target: event.target.tagName,
        };
      },
      { once: true },
    );
  });
  await page.locator('.paper').click({ position: { x: 300, y: 300 } });
  await page.keyboard.press('Control+v');
  console.log('paste-event', await page.evaluate(() => window.__pasteDebug));
  await expect(page.getByLabel('图片对象', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '任务与后端', exact: true }).click();
  await expect(page.getByLabel('模型闲置卸载时间（秒）', { exact: true })).toHaveValue('1800');
  await page.getByLabel('模型闲置卸载时间（秒）', { exact: true }).fill('600');
  await page.getByRole('button', { name: '保存闲置设置', exact: true }).click();
  assert.equal(
    (
      await page.evaluate(() =>
        window.surfaceDesktop.dictation.run({ action: 'idle-policy', idleReleaseSeconds: 600 }),
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await page.evaluate(() =>
        window.surfaceDesktop.dictation.run({ action: 'idle-policy', idleReleaseSeconds: 29 }),
      )
    ).error,
    'invalid',
  );
  await page.screenshot({ path: 'test-results/tixtab-idle-desktop.png' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      nativeTextPaste: true,
      normalFieldPaste: true,
      nativeImagePaste: true,
      editableText: true,
      idlePolicyIPC: true,
      title: true,
      rendererErrors: errors,
    }),
  );
} finally {
  await app.close();
}
