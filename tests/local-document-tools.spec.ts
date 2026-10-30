import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
const xml = `<?xml version="1.0"?><score-partwise version="4.0"><defaults><page-layout><page-width>1000</page-width><page-height>1400</page-height></page-layout></defaults><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1" width="800"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><print><system-layout><top-system-distance>100</top-system-distance></system-layout></print><note default-x="100" default-y="-10"><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note><note default-x="300" default-y="-15"><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`;
async function fixture(page: any, count = 2, scoreXml: string | string[] = xml) {
  await page.addInitScript(
    ({ xml }: any) => {
      (window as any).toolCalls = [];
      let recognized = 0;
      (window as any).surfaceDesktop = {
        onFullscreen: () => () => {},
        toggleFullscreen: async () => false,
        models: {
          list: async () =>
            ['uvdoc', 'docaligner', 'audiveris', 'homr', 'copista', 'matchmaker'].map((id) => ({
              id,
              source: 'bundled',
              bundled: true,
            })),
          onProgress: () => () => {},
        },
        documentTools: {
          run: async (r: any) => {
            (window as any).toolCalls.push(r);
            if (r.action === 'status')
              return {
                ok: true,
                data: { document: true, homr: true, audiveris: true, copista: true },
              };
            if (r.action === 'correct')
              return { ok: true, data: { image: r.image, model: 'UVDoc', device: 'NPU' } };
            if (r.action === 'recognize')
              return {
                ok: true,
                data: {
                  musicxml: Array.isArray(xml) ? xml[recognized++ % xml.length] : xml,
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
    { xml: scoreXml },
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
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
  for (let i = 0; i < count; i++)
    pdf.addPage([360, 480]).drawImage(image, { x: 0, y: 0, width: 360, height: 480 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Local tools.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
test('Copista persists recognized scores and microphone CQT following turns pages and releases resources', async ({
  page,
}) => {
  const melody = [
    60, 64, 67, 62, 69, 65, 71, 67, 72, 69, 74, 71, 65, 67, 64, 60, 62, 65, 69, 72, 67, 71, 74, 76,
  ];
  const names = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
  const scores = [0, 8, 16].map(
    (offset) =>
      `<score-partwise><part-list><score-part id="p"><part-name>Piano</part-name></score-part></part-list><part id="p">${[
        0, 4,
      ]
        .map(
          (start) =>
            `<measure number="${start / 4 + 1}"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${melody
              .slice(offset + start, offset + start + 4)
              .map(
                (midi) =>
                  `<note><pitch><step>${names[midi % 12]}</step><octave>${Math.floor(midi / 12) - 1}</octave></pitch><duration>1</duration></note>`,
              )
              .join('')}</measure>`,
        )
        .join('')}</part></score-partwise>`,
  );
  await page.addInitScript(
    ({ melody }) => {
      const state = ((window as any).followTest = { tracks: 0, workers: 0, samples: 0 });
      const OriginalWorker = window.Worker;
      (window as any).Worker = class extends OriginalWorker {
        private follower: boolean;
        constructor(url: any, options: any) {
          super(url, options);
          this.follower = String(url).includes('musicFollow');
          if (this.follower) state.workers++;
        }
        terminate() {
          if (this.follower) {
            state.workers--;
            this.follower = false;
          }
          super.terminate();
        }
      };
      let began = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: async () => {
          began = performance.now();
          state.tracks++;
          let stopped = false;
          return {
            getTracks: () => [
              {
                stop: () => {
                  if (!stopped) state.tracks--;
                  stopped = true;
                },
              },
            ],
          };
        },
      });
      AudioContext.prototype.createMediaStreamSource = function () {
        const rate = this.sampleRate;
        return {
          disconnect() {},
          connect(analyser: AnalyserNode) {
            analyser.getFloatTimeDomainData = (buffer: Float32Array) => {
              state.samples++;
              const beat = ((performance.now() - began) / 1000) * 2;
              const midi = melody[Math.min(melody.length - 1, Math.floor(beat))];
              const frequency = 440 * 2 ** ((midi - 69) / 12);
              for (let i = 0; i < buffer.length; i++)
                buffer[i] = 0.15 * Math.sin((2 * Math.PI * frequency * i) / rate);
            };
          },
        } as any;
      };
    },
    { melody },
  );
  await fixture(page, 3, scores);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('五线谱后端', { exact: true }).selectOption('copista');
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(
    page.locator('.local-document-dialog > .local-document-body > p[role=status]'),
  ).toContainText('已完成 3');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  const player = page.getByLabel('五线谱播放器', { exact: true });
  const selector = player.getByLabel('乐谱页面', { exact: true });
  const second = await selector.locator('option').nth(1).getAttribute('value');
  await player.getByRole('button', { name: '声音跟随翻页', exact: true }).click();
  await expect(player.getByRole('meter', { name: '麦克风输入电平' })).toBeVisible();
  await expect(selector).toHaveValue(second!, { timeout: 12000 });
  await expect(page.locator('.music-score-layer line')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).followTest.tracks)).toBe(1);
  await selector.selectOption({ index: 0 });
  await expect(player).toContainText('正在聆听演奏');
  await expect(selector).toHaveValue(
    (await selector.locator('option').first().getAttribute('value'))!,
  );
  await player.getByRole('button', { name: '声音跟随翻页', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).followTest.workers)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).followTest.tracks)).toBe(0);
  await player.getByRole('button', { name: '声音跟随翻页', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).followTest.workers)).toBe(1);
  await player.getByRole('button', { name: '关闭播放器', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).followTest.tracks + (window as any).followTest.workers),
    )
    .toBe(0);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  const engines = await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string);
    return (await s.bootstrapWorkspace()).notebook.pages.map((p: any) => p.score?.engine);
  });
  expect(engines).toEqual(['copista', 'copista', 'copista']);
});

test('real Copista output retains detected note and system positions', async ({ page }) => {
  const actual = await fs.readFile('.cache/copista/smoke/input.musicxml', 'utf8').catch(() => null);
  const layout = await fs.readFile('.cache/copista/smoke/result.json', 'utf8').catch(() => null);
  test.skip(!actual || !layout, 'Requires the local Copista smoke recognition output');
  await page.goto('/');
  const result = await page.evaluate(
    async ({ xml, layout }) => {
      const s = await import('/src/musicScore.ts' as string);
      const score = s.parseMusicScore(xml!, 'copista', JSON.parse(layout!).data);
      return {
        valid: s.validMusicScore(score),
        positioning: score.positioning,
        count: score.notes.length,
        systems: score.systems.length,
      };
    },
    { xml: actual, layout },
  );
  expect(result.valid).toBe(true);
  expect(result.positioning).toBe('layout');
  expect(result.count).toBeGreaterThan(100);
  expect(result.systems).toBe(4);
});

test('document correction previews, applies below handwriting, indexes only and picks a specified bitmap', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '文档矫正', exact: true }).click();
  await page.getByLabel('校准算法', { exact: true }).selectOption('uvdoc');
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

test('manual correction edits corners and mesh, requires a fresh preview and clears per-image points on scope change', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '文档矫正', exact: true }).click();
  await page.getByRole('button', { name: '选择图片并调整', exact: true }).click();
  const apply = page.getByRole('button', { name: '应用预览', exact: true });
  await expect(apply).toBeDisabled();
  const handle = page.getByRole('slider', { name: '校准点 1', exact: true });
  await handle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByLabel('校准算法', { exact: true })).toHaveValue('manual');
  await page.getByLabel('输出比例', { exact: true }).selectOption('id-landscape');
  await page.getByRole('button', { name: '更新预览', exact: true }).click();
  await expect(apply).toBeEnabled();
  const corners = await page.evaluate(() =>
    (window as any).toolCalls.filter((r: any) => r.action === 'correct').at(-1),
  );
  expect(corners.engine).toBe('geometry');
  expect(corners.options.corners[0]).toEqual([0.01, 0.01]);
  expect(corners.options.aspect).toBe('id-landscape');
  await page.getByRole('button', { name: '曲面网格', exact: true }).click();
  const centre = page.getByRole('slider', { name: '校准点 13', exact: true });
  await centre.scrollIntoViewIfNeeded();
  const b = (await centre.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 15, b.y + b.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await expect(apply).toBeDisabled();
  await expect(page.getByRole('button', { name: '开始矫正', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '更新预览', exact: true }).click();
  await expect(apply).toBeEnabled();
  const mesh = await page.evaluate(
    () => (window as any).toolCalls.filter((r: any) => r.action === 'correct').at(-1).options,
  );
  expect(mesh.mesh).toHaveLength(25);
  expect(mesh.mesh[12][0]).toBeGreaterThan(0.5);
  expect(mesh.corners).toBeUndefined();
  await page
    .locator('.correction-editor')
    .screenshot({ path: '.cache/follow-correction/editor.png' });
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await expect(page.locator('.correction-editor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始矫正', exact: true })).toBeEnabled();
});

test('Matchmaker streams continuous AudioWorklet PCM, follows pages and releases microphone on stop', async ({
  page,
}) => {
  await fixture(page, 3);
  await page.evaluate(() => {
    const w = window as any;
    w.nativeFollowCalls = [];
    let beat = 0,
      referenceKey: string | undefined;
    w.surfaceDesktop.musicFollow = {
      onProgress: () => () => {},
      run: async (r: any) => {
        w.nativeFollowCalls.push({
          action: r.action,
          epoch: r.epoch,
          time: r.time,
          count: r.samples?.length,
          method: r.method,
          referenceKey: r.referenceKey,
          uploaded: !!r.notes,
        });
        if (r.action === 'audio' && w.nextFollowError) {
          const error = w.nextFollowError;
          delete w.nextFollowError;
          return error;
        }
        if (r.action === 'start') {
          if (r.notes) referenceKey = r.referenceKey;
          if (referenceKey !== r.referenceKey) return { ok: false, error: 'reference-missing' };
        }
        if (r.action === 'seek' || r.action === 'start') beat = r.beat;
        return r.action === 'audio'
          ? {
              ok: true,
              data: {
                state: 'matched',
                beat: Math.min(5.5, (beat += 0.08)),
                epoch: r.epoch,
                level: 0.1,
              },
            }
          : { ok: true };
      },
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const ctx = new AudioContext(),
          osc = ctx.createOscillator(),
          sink = ctx.createMediaStreamDestination();
        osc.frequency.value = 440;
        osc.connect(sink);
        osc.start();
        await ctx.resume();
        w.testMicStream = sink.stream;
        w.testMicCleanup = () => {
          osc.stop();
          void ctx.close();
        };
        return sink.stream;
      },
    });
  });
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.local-document-body > p[role=status]')).toContainText('已完成 3');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  const player = page.getByLabel('五线谱播放器', { exact: true });
  await expect(player.getByLabel('跟谱后端', { exact: true })).toHaveValue('global');
  const follow = player.getByRole('button', { name: '声音跟随翻页', exact: true });
  await follow.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).nativeFollowCalls.find((r: any) => r.action === 'start')?.method,
      ),
    )
    .toBe('global');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).nativeFollowCalls.filter((r: any) => r.action === 'audio').length,
      ),
    )
    .toBeGreaterThan(10);
  const calls = await page.evaluate(() =>
    (window as any).nativeFollowCalls.filter((r: any) => r.action === 'audio'),
  );
  expect(calls.every((r: any) => r.count === 640)).toBe(true);
  for (let i = 1; i < calls.length; i++)
    expect(calls[i].time - calls[i - 1].time).toBeCloseTo(0.04, 4);
  const pages = player.getByLabel('乐谱页面', { exact: true });
  await expect(pages).toHaveValue((await pages.locator('option').nth(2).getAttribute('value'))!, {
    timeout: 8000,
  });
  await pages.selectOption({ index: 0 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).nativeFollowCalls.some((r: any) => r.action === 'seek' && r.epoch > 0),
      ),
    )
    .toBe(true);
  await follow.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).testMicStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
  const stopped = await page.evaluate(
    () => (window as any).nativeFollowCalls.filter((r: any) => r.action === 'audio').length,
  );
  await page.waitForTimeout(180);
  expect(
    await page.evaluate(
      () => (window as any).nativeFollowCalls.filter((r: any) => r.action === 'audio').length,
    ),
  ).toBe(stopped);
  await player.screenshot({ path: '.cache/follow-correction/player.png' });
  await page.evaluate(() => (window as any).testMicCleanup());
  await follow.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).nativeFollowCalls.filter((r: any) => r.action === 'audio').length,
      ),
    )
    .toBeGreaterThan(stopped + 3);
  const starts = await page.evaluate(() =>
    (window as any).nativeFollowCalls.filter((r: any) => r.action === 'start'),
  );
  expect(starts).toHaveLength(3); // One miss + upload, then one warm start.
  expect(starts.filter((r: any) => r.uploaded)).toHaveLength(1);
  expect(starts[2].referenceKey).toBe(starts[1].referenceKey);
  await page.evaluate(() => {
    (window as any).nextFollowError = {
      ok: false,
      error: 'worker-exited',
      logs: 'RuntimeError: test worker stopped during audio analysis',
    };
  });
  await expect(player.locator('p[role="status"]')).toContainText('跟谱组件意外退出');
  await expect(player).toHaveAttribute('data-following', 'false');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).testMicStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
  await player.getByText('错误详情', { exact: true }).click();
  await expect(player.locator('.music-follow-diagnostics pre')).toContainText(
    'RuntimeError: test worker stopped',
  );
  await page.evaluate(() => (window as any).testMicCleanup());
  await follow.click();
  await expect(player.locator('.music-follow-diagnostics')).toHaveCount(0);
  await expect(player).toHaveAttribute('data-following', 'true');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).nativeFollowCalls.filter((r: any) => r.action === 'start').length,
      ),
    )
    .toBe(4);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).testMicStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === 'live'),
      ),
    )
    .toBe(true);
  await follow.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).testMicStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).testMicCleanup());
});

test('presentation follows live music playback and shared audio-follow positions in all three views', async ({
  page,
}) => {
  await fixture(page, 3);
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Local tools',
  );
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.local-document-body > p[role=status]')).toContainText('已完成 3');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  const player = page.getByLabel('五线谱播放器', { exact: true });
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await player.getByLabel('乐谱页面', { exact: true }).selectOption({ index: 0 });
    await player.getByLabel('播放速度', { exact: true }).fill('240');
    await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
    await page.getByRole('button', { name: '展示全屏', exact: true }).click();
    const display = page.locator('.presentation-view');
    await expect(player).toBeVisible();
    await expect(player.getByRole('button')).toHaveCount(2);
    await expect(display).toHaveAttribute('data-page-index', '2', { timeout: 6000 });
    await expect(display.locator('.music-score-layer line')).toHaveCount(1);
    // Both playback and microphone following publish through this same cursor.
    await expect(
      player.getByRole('button', { name: '播放乐谱', exact: true, includeHidden: true }),
    ).toHaveCount(1, {
      timeout: 6000,
    });
    await page.evaluate(async () => {
      const s = await import('/src/workspaceStore.ts' as string),
        t = await import('/src/musicTransport.ts' as string);
      const n = (await s.bootstrapWorkspace()).notebook;
      t.setScoreCursor({ pageId: n.pages[0].id, beat: 0, seek: () => {} });
    });
    await expect(display).toHaveAttribute('data-page-index', '0');
    await page.keyboard.press('Escape');
    await expect(display).toHaveCount(0);
    await expect(player).toBeVisible();
  }
});

for (const presentation of [false, true]) {
  test(`dual-page music waits for the right page before turning two pages${presentation ? ' in presentation' : ''}`, async ({
    page,
  }) => {
    await fixture(page, 6);
    await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
      'Local tools',
    );
    await page.getByRole('button', { name: '额外工具', exact: true }).click();
    await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
    await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await expect(page.locator('.local-document-body > p[role=status]')).toContainText('已完成 6');
    await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
    await page.getByRole('button', { name: '双页预览', exact: true }).click();
    // Shift the spread to pages 2–3: fixed even/odd pairing used to turn too early here.
    await page.getByRole('button', { name: '向后移动一页', exact: true }).click();
    const player = page.getByLabel('五线谱播放器', { exact: true });
    const selected = player.getByLabel('乐谱页面', { exact: true });
    await selected.selectOption({ index: 1 });
    await player.getByLabel('播放速度', { exact: true }).fill('60');
    await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
    if (presentation) await page.getByRole('button', { name: '展示全屏', exact: true }).click();
    const view = page.locator(
      presentation ? '.presentation-view .reading-dual' : '#root .reading-dual',
    );
    const displayed = () =>
      view
        .locator('.reading-card')
        .evaluateAll((cards) => cards.map((card) => Number(card.getAttribute('data-page-index'))));
    await expect.poll(displayed).toEqual([1, 2]);
    for (const [sounding, spread] of [
      [2, [1, 2]],
      [3, [3, 4]],
      [4, [3, 4]],
      [5, [5]],
    ] as const) {
      await expect(player).toHaveAttribute('data-page-index', String(sounding));
      await expect.poll(displayed).toEqual([...spread]);
      await expect(
        view.locator(`[data-page-index="${sounding}"] .music-score-layer line`),
      ).toHaveCount(1);
    }
    if (presentation) await page.keyboard.press('Escape');
    await player.getByRole('button', { name: '暂停乐谱', exact: true }).click();
  });
}

test('collapsed and fullscreen player controls work and project preferences survive repeated imports', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.local-document-body > p[role=status]')).toContainText('已完成 2');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const context = new AudioContext();
        const stream = context.createMediaStreamDestination().stream;
        (window as any).playerMic = { context, stream };
        return stream;
      },
    });
  });
  const player = page.getByLabel('五线谱播放器', { exact: true });
  await player.getByLabel('播放速度', { exact: true }).fill('73');
  await player.getByLabel('乐谱音量', { exact: true }).fill('0.4');
  await player.getByLabel('MIDI 音色', { exact: true }).selectOption('40');
  await player.getByLabel('播放音源', { exact: true }).selectOption('internal');
  await player.getByRole('button', { name: '收起播放器', exact: true }).click();
  await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
  await expect(player).toHaveAttribute('data-playing', 'true');
  await player.getByRole('button', { name: '暂停乐谱', exact: true }).click();
  await page.getByRole('button', { name: '展示全屏', exact: true }).click();
  await expect(player).toBeVisible();
  await expect(player.getByRole('button')).toHaveCount(2);
  const box = (await player.boundingBox())!;
  expect(box.y).toBeLessThan(60);
  expect(box.x).toBeGreaterThan(1100);
  await page.screenshot({ path: '.cache/music-player-shortcuts.png' });
  await player.getByRole('button', { name: '声音跟随翻页', exact: true }).click();
  await expect(player).toHaveAttribute('data-following', 'true');
  await expect
    .poll(() => page.evaluate(() => !!(window as any).playerMic?.stream.active))
    .toBe(true);
  await player.getByRole('button', { name: '声音跟随翻页', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).playerMic.stream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).playerMic.context.close());
  await page.keyboard.press('Escape');
  await expect(page.locator('.presentation-view')).toHaveCount(0);
  await expect(player.getByRole('button', { name: '收起播放器', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute('data-playing', 'false');
  await expect(player).toHaveAttribute('data-following', 'false');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const bytes = await fs.readFile((await (await download).path())!);
  expect(JSON.parse(bytes.toString()).musicPlayer).toMatchObject({
    open: true,
    collapsed: true,
    tempo: 73,
    volume: 0.4,
    instrument: 40,
    output: 'internal',
  });
  for (let i = 0; i < 2; i++) {
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'Player.tixtab', mimeType: 'application/json', buffer: bytes });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await expect(player).toBeVisible();
    await expect(player.getByRole('button', { name: '收起播放器', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await player.getByRole('button', { name: '收起播放器', exact: true }).click();
    await expect(player.getByLabel('播放速度', { exact: true })).toHaveValue('73');
    await expect(player.getByLabel('乐谱音量', { exact: true })).toHaveValue('0.4');
    await expect(player.getByLabel('MIDI 音色', { exact: true })).toHaveValue('40');
    await player.getByRole('button', { name: '关闭播放器', exact: true }).click();
    await expect(player).toHaveCount(0);
    await expect(page.locator('.save-state')).toContainText('已自动保存');
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '额外工具', exact: true })).toBeEnabled();
  await expect(player).toHaveCount(0);
});

test('background correction keeps its PDF alive across tabs and preserves new handwriting', async ({
  page,
}) => {
  await fixture(page);
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Local tools',
  );
  await page.evaluate(() => {
    const bridge = (window as any).surfaceDesktop.documentTools,
      original = bridge.run;
    (window as any).__correctionNumber = 0;
    bridge.run = async (r: any) => {
      if (r.action === 'correct') {
        (window as any).__correctionNumber++;
        await new Promise<void>((resolve) => {
          (window as any).__completeCorrection = resolve;
        });
      }
      return original(r);
    };
  });
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '文档矫正', exact: true }).click();
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始矫正', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__correctionNumber)).toBe(1);
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  await expect(page.getByLabel('后台任务', { exact: true })).toContainText('文档矫正');
  const box = (await page.locator('.page-editor').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: '新建文档标签', exact: true }).click();
  await page.getByRole('textbox', { name: '文档名称', exact: true }).fill('Other document');
  await page.evaluate(() => (window as any).__completeCorrection());
  await expect.poll(() => page.evaluate(() => (window as any).__correctionNumber)).toBe(2);
  await page.evaluate(() => (window as any).__completeCorrection());
  await expect(page.getByLabel('后台任务', { exact: true })).toContainText('已完成 2');
  await expect(page.getByRole('button', { name: '停止任务 文档矫正', exact: true })).toHaveCount(0);
  const state = await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string),
      list = (await s.listWorkspace()).documents;
    const n = (
      await s.loadWorkspaceDocument(list.find((d: any) => d.name === 'Local tools').id, false)
    ).notebook;
    return {
      strokes: n.pages[0].strokes.length,
      corrected: n.pages.map((p: any) => p.images.filter((i: any) => i.correction).length),
    };
  });
  expect(state).toEqual({ strokes: 1, corrected: [1, 1] });
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Other document',
  );
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Other document',
  );
});
test('system MIDI output preserves page turns, changes instruments, stops on seek and remembers the selected source', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.midiCalls = [];
    w.midiListeners = new Set();
    w.surfaceDesktop.musicOutput = {
      run: async (request: any) => {
        w.midiCalls.push(request);
        if (request.action === 'list')
          return {
            ok: true,
            devices: [
              { id: 'system-piano', name: 'Microsoft GS Wavetable Synth', software: true },
              { id: 'bridge', name: 'TouchOSC Bridge', software: false },
            ],
          };
        if (request.action === 'play') return { ok: true, startedAt: Date.now() + 60 };
        return { ok: true };
      },
      onState: (listener: any) => {
        w.midiListeners.add(listener);
        return () => w.midiListeners.delete(listener);
      },
    };
  });
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByLabel('文档工具范围', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(
    page.locator('.local-document-dialog > .local-document-body > p[role=status]'),
  ).toContainText('已完成 2');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  const player = page.getByLabel('五线谱播放器', { exact: true });
  await expect(player.getByLabel('播放音源', { exact: true })).toHaveValue('auto');
  await expect(player.locator('.music-output-name')).toHaveText('Microsoft GS Wavetable Synth');
  await expect
    .poll(async () => {
      const box = await player.boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= 960;
    })
    .toBe(true);
  await player.screenshot({ path: '.cache/copista/midi-player.png' });
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const pages = player.getByLabel('乐谱页面', { exact: true });
    await pages.selectOption({ index: 0 });
    await player.getByLabel('播放速度', { exact: true }).fill('240');
    await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
    await expect(pages).toHaveValue(
      (await pages.locator('option').nth(1).getAttribute('value')) as string,
    );
    const pause = player.getByRole('button', { name: '暂停乐谱', exact: true });
    if (await pause.count()) await pause.click();
  }
  await player.getByLabel('乐谱页面', { exact: true }).selectOption({ index: 0 });
  await player.getByLabel('播放速度', { exact: true }).fill('60');
  await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
  await player.getByLabel('MIDI 音色', { exact: true }).selectOption('40');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).midiCalls.some((c: any) => c.action === 'configure' && c.program === 40),
      ),
    )
    .toBe(true);
  await player.getByLabel('乐谱进度', { exact: true }).fill('1');
  await expect(player.getByRole('button', { name: '播放乐谱', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).midiListeners.size)).toBe(0);
  await player.getByLabel('播放音源', { exact: true }).selectOption('bridge');
  expect(await page.evaluate(() => localStorage.getItem('tixtab.musicOutput'))).toBe('bridge');
  await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as any).midiCalls.filter((c: any) => c.action === 'play').at(-1).output,
    ),
  ).toBe('bridge');
  await page.evaluate(() => {
    const w = window as any,
      token = w.midiCalls.filter((c: any) => c.action === 'play').at(-1).token;
    for (const listener of w.midiListeners)
      listener({ token, state: 'error', error: 'device-unavailable' });
  });
  await expect(player).toContainText('音源无法播放或已断开');
  await player.getByLabel('播放音源', { exact: true }).selectOption('internal');
  await player.getByRole('button', { name: '播放乐谱', exact: true }).click();
  await expect(player.getByRole('button', { name: '暂停乐谱', exact: true })).toBeVisible();
  await player.getByRole('button', { name: '关闭播放器', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).midiListeners.size)).toBe(0);
  const calls = await page.evaluate(() => (window as any).midiCalls);
  for (const call of calls.filter((c: any) => c.action === 'play'))
    expect(calls.some((c: any) => c.action === 'stop' && c.token === call.token)).toBe(true);
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
  // Exercise a real hit within the system; a coordinate-free synthetic event
  // points outside the score and must not select a note.
  await page
    .locator('.music-score-layer rect')
    .first()
    .click({ position: { x: 4, y: 4 } });
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
    await player.getByLabel('播放速度', { exact: true }).focus();
    await page.keyboard.press('End');
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

test('tempo slider supports keyboard and wheel; extra tools all have leading icons', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  for (const name of ['文档矫正', '五线谱识别', '五线谱播放器'])
    await expect(page.getByRole('menuitem', { name, exact: true }).locator('svg')).toHaveCount(1);
  await page.getByRole('menuitem', { name: '五线谱识别', exact: true }).click();
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(
    page.locator('.local-document-dialog > .local-document-body > p[role=status]'),
  ).toContainText('已完成');
  await page.getByRole('button', { name: '关闭文档工具', exact: true }).click();
  const slider = page.getByLabel('播放速度', { exact: true });
  await slider.dispatchEvent('wheel', { deltaY: -100 });
  await expect(slider).toHaveValue('121');
  await slider.dispatchEvent('wheel', { deltaY: -100, shiftKey: true });
  await expect(slider).toHaveValue('126');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('20');
  await slider.dispatchEvent('wheel', { deltaY: 100 });
  await expect(slider).toHaveValue('20');
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('400');
  await slider.dispatchEvent('wheel', { deltaY: -100 });
  await expect(slider).toHaveValue('400');
});

test('homr maps XML note identities rather than timing spacing, including repeats and tied row changes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { parseMusicScore, validMusicScore } = await import('/src/musicScore.ts' as string);
    const { cursorNote, timelineNotes, scoreTimeline } = await import(
      '/src/musicTransport.ts' as string
    );
    const note = (id: string, tie = '') =>
      `<note id="${id}"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>${tie}</note>`;
    const xml = `<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><barline><repeat direction="forward"/></barline>${note('first', '<tie type="start"/>')}</measure><measure number="2"><print new-system="yes"/>${note('continuation', '<tie type="stop"/>')}<barline><repeat direction="backward"/></barline></measure></part></score-partwise>`;
    const r = (x: number, y: number) => ({ x, y, width: 0.02, height: 0.02 });
    const score = parseMusicScore(xml, 'homr', {
      systems: [r(0.1, 0.2), r(0.1, 0.6)],
      noteLocations: {
        first: { system: 0, region: r(0.7, 0.2) },
        continuation: { system: 1, region: r(0.15, 0.6) },
      },
    });
    return {
      valid: validMusicScore(score),
      count: score.notes.length,
      positions: [0, 3.9, 4, 7.9, 8, 12].map((beat) => {
        const n = cursorNote(score, beat);
        return [n.system, n.region.x];
      }),
      duration: score.duration,
      audioNotes: timelineNotes(scoreTimeline([{ id: 'page', score }])).length,
    };
  });
  expect(result).toEqual({
    valid: true,
    count: 2,
    positions: [
      [0, 0.7],
      [0, 0.7],
      [1, 0.15],
      [1, 0.15],
      [0, 0.7],
      [1, 0.15],
    ],
    duration: 16,
    audioNotes: 2,
  });
});

test('real homr recognition retains XML note identity and uses normalized detector locations', async ({
  page,
}) => {
  const directory = '.cache/document-tools/homr-layout-smoke';
  const fixture = await Promise.all([
    fs.readFile(directory + '/input.musicxml', 'utf8'),
    fs.readFile(directory + '/input.staffs.json', 'utf8'),
  ]).catch(() => null);
  if (!fixture) {
    test.skip();
    return;
  }
  await page.goto('/');
  const result = await page.evaluate(
    async ({ xml, layout }) => {
      const { parseMusicScore, validMusicScore } = await import('/src/musicScore.ts' as string);
      const score = parseMusicScore(xml, 'homr', layout);
      return {
        valid: validMusicScore(score),
        count: score.notes.length,
        systems: score.systems.length,
        found: score.notes.every((n) =>
          Object.values(layout.noteLocations).some(
            (l: any) => l.system === n.system && l.region.x === n.region.x,
          ),
        ),
      };
    },
    { xml: fixture[0], layout: JSON.parse(fixture[1]) },
  );
  expect(result.valid).toBe(true);
  expect(result.count).toBeGreaterThan(100);
  expect(result.systems).toBe(2);
  expect(result.found).toBe(true);
});

for (const failure of ['missing', 'render'] as const) {
  test(`extra tools isolate ${failure} failure and keep the document usable`, async ({ page }) => {
    await fixture(page);
    await page.route('**/src/LocalDocumentToolDialog.tsx*', (route) =>
      route.fulfill(
        failure === 'missing'
          ? { status: 404, contentType: 'text/javascript', body: 'missing old build' }
          : {
              status: 200,
              contentType: 'text/javascript',
              body: 'export default function Tool() { throw new Error("test render failure"); }',
            },
      ),
    );
    for (const tool of ['文档矫正', '五线谱识别']) {
      await page.getByRole('button', { name: '额外工具', exact: true }).click();
      await page.getByRole('menuitem', { name: tool, exact: true }).click();
      const message = page.locator('.feature-message');
      await expect(message).toContainText('文档仍可继续编辑和保存');
      await expect(page.locator('.app-shell')).toHaveCount(1);
      if (failure === 'missing') await expect(message).toContainText('保存工程后重新打开应用');
      await message.locator('footer').getByRole('button', { name: '关闭', exact: true }).click();
      await expect(message).toHaveCount(0);
    }
    await page.getByRole('button', { name: '额外工具', exact: true }).click();
    await page.getByRole('menuitem', { name: '提取图片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '提取图片', exact: true })).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(1);
  });
}
