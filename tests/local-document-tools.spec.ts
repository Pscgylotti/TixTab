import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
const xml = `<?xml version="1.0"?><score-partwise version="4.0"><defaults><page-layout><page-width>1000</page-width><page-height>1400</page-height></page-layout></defaults><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1" width="800"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><print><system-layout><top-system-distance>100</top-system-distance></system-layout></print><note default-x="100" default-y="-10"><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note><note default-x="300" default-y="-15"><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`;
async function fixture(page: any) {
  await page.addInitScript(
    ({ xml }: any) => {
      (window as any).toolCalls = [];
      (window as any).surfaceDesktop = {
        onFullscreen: () => () => {},
        toggleFullscreen: async () => false,
        models: {
          list: async () =>
            ['uvdoc', 'audiveris', 'homr'].map((id) => ({ id, source: 'bundled', bundled: true })),
          onProgress: () => () => {},
        },
        documentTools: {
          run: async (r: any) => {
            (window as any).toolCalls.push(r);
            if (r.action === 'status')
              return { ok: true, data: { document: true, homr: true, audiveris: true } };
            if (r.action === 'correct')
              return { ok: true, data: { image: r.image, model: 'UVDoc', device: 'NPU' } };
            if (r.action === 'recognize')
              return {
                ok: true,
                data: {
                  musicxml: xml,
                  engine: r.engine,
                  systems:
                    r.engine === 'homr' ? [{ x: 0.1, y: 0.2, width: 0.8, height: 0.2 }] : undefined,
                },
              };
            return { ok: true };
          },
        },
      };
    },
    { xml },
  );
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const bytes = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 360;
    c.height = 480;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 360, 480);
    ctx.fillStyle = 'black';
    ctx.fillText('Scan test', 30, 40);
    return c.toDataURL('image/png').split(',')[1];
  });
  const pdf = await PDFDocument.create(),
    image = await pdf.embedPng(Buffer.from(bytes, 'base64'));
  for (let i = 0; i < 2; i++)
    pdf.addPage([360, 480]).drawImage(image, { x: 0, y: 0, width: 360, height: 480 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Local tools.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
test('document correction previews, applies below handwriting, indexes only and picks a specified bitmap', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '文档矫正', exact: true }).click();
  await page.getByLabel('矫正设备', { exact: true }).selectOption('NPU');
  await page.getByRole('button', { name: '预览第一张', exact: true }).click();
  await expect(page.getByAltText('矫正后', { exact: true })).toBeVisible();
  await expect(
    page.locator('.local-document-dialog > .local-document-body > p[role=status]'),
  ).toContainText('预览已生成');
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect(
    page.locator('.local-document-dialog > .local-document-body > p[role=status]'),
  ).toContainText('已应用矫正');
  await page.getByRole('button', { name: '点击指定图片', exact: true }).click();
  await expect(page.locator('.local-pick-banner')).toBeVisible();
  await page.locator('.local-image-picker polygon').first().click({ force: true });
  await expect(page.getByLabel('文档工具范围', { exact: true })).toHaveValue('picked');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  const n = await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string);
    return (await s.bootstrapWorkspace()).notebook;
  });
  expect(n.pages[0].images[0].correction.sourceImageIndex).toBe(0);
  expect(n.pages[0].inkLayer).toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).toolCalls.filter((r: any) => r.action === 'correct')[0].device,
    ),
  ).toBe('NPU');
});
test('recognized scores persist, correct MIDI, seek from the page and auto turn in all layouts', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(
    page.locator('.local-document-dialog > .local-document-body > p[role=status]'),
  ).toContainText('已完成 2');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  const player = page.getByLabel('五线谱播放器', { exact: true });
  await expect(player).toBeVisible();
  await expect(player.getByLabel('MIDI 音色', { exact: true })).toHaveValue('0');
  await player.getByLabel('MIDI 音色', { exact: true }).selectOption('40');
  await player.getByRole('button', { name: '修正音符', exact: true }).click();
  await page
    .locator('.music-score-layer rect')
    .first()
    .dispatchEvent('pointerdown', { pointerId: 1, button: 0, bubbles: true });
  await player.getByLabel('音符 MIDI 音高', { exact: true }).fill('72');
  const download = page.waitForEvent('download');
  await player.getByRole('button', { name: 'MIDI ↓', exact: true }).click();
  const d = await download;
  const midi = await fs.readFile((await d.path())!);
  expect(midi.subarray(0, 4).toString()).toBe('MThd');
  expect(midi[midi.indexOf(0xc0) + 1]).toBe(40);
  await player.getByRole('button', { name: '修正音符', exact: true }).click();
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await player.getByLabel('乐谱页面', { exact: true }).selectOption({ index: 0 });
    await player.getByLabel('播放速度', { exact: true }).fill('400');
    await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
    await expect(player.getByLabel('乐谱页面', { exact: true })).toHaveValue(
      await player.locator('option').nth(1).getAttribute('value'),
      { timeout: 5000 },
    );
    await expect(page.locator('.music-score-layer line')).toHaveCount(1);
    const pause = player.getByRole('button', { name: '暂停乐谱', exact: true });
    if (await pause.count()) await pause.click();
  }
  await player.getByRole('button', { name: '关闭播放器', exact: true }).click();
  await expect(page.locator('.music-score-layer')).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const scores = await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string);
    return (await s.bootstrapWorkspace()).notebook.pages.map((p: any) => p.score);
  });
  expect(scores).toHaveLength(2);
  expect(scores[0].notes[0].midi).toBe(72);
});
test('parses real Audiveris exported MusicXML with bounded notes and normalized positions', async ({
  page,
}) => {
  await page.goto('/');
  const actual = await fs
    .readFile('.cache/document-tools/audiveris-result.musicxml', 'utf8')
    .catch(() => null);
  if (!actual) {
    test.skip();
    return;
  }
  const result = await page.evaluate(async (xml) => {
    const s = await import('/src/musicScore.ts' as string),
      score = s.parseMusicScore(xml, 'audiveris');
    return {
      valid: s.validMusicScore(score),
      notes: score.notes.length,
      systems: score.systems.length,
      positioning: score.positioning,
    };
  }, actual);
  expect(result.valid).toBe(true);
  expect(result.notes).toBeGreaterThan(50);
  expect(result.positioning).toBe('layout');
});

test('homr option maps estimated coordinates and stopping a live correction leaves UI responsive', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('五线谱后端', { exact: true }).selectOption('homr');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.local-document-body > p[role=status]')).toContainText('已完成 1');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  await expect(page.getByLabel('五线谱播放器', { exact: true })).toContainText('谱面位置为估计值');
  await page.getByRole('button', { name: '关闭播放器', exact: true }).click();
  await page.evaluate(() => {
    const bridge = (window as any).surfaceDesktop.documentTools,
      old = bridge.run;
    let pending: ((r: any) => void) | undefined;
    bridge.run = (r: any) => {
      if (r.action === 'correct') return new Promise((resolve) => (pending = resolve));
      if (r.action === 'cancel') {
        pending?.({ ok: false, error: 'cancelled' });
        return Promise.resolve({ ok: true });
      }
      return old(r);
    };
  });
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '文档矫正', exact: true }).click();
  await page.getByRole('button', { name: '开始矫正', exact: true }).click();
  await expect(page.locator('.local-document-body > p[role=status]')).toContainText('正在矫正文档');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.local-document-body > p[role=status]')).toContainText('已停止');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
});
