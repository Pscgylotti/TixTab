import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
test.use({ hasTouch: true });
async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  await page.locator('input[type=file]').setInputFiles({
    name: 'Camera touch.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Camera touch',
  );
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function stored(page: Page) {
  return page.evaluate(
    async () =>
      (await (await import('/src/workspaceStore.ts' as string)).bootstrapWorkspace()).notebook,
  );
}
async function camera(page: Page) {
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '拍照', exact: true }).click();
  return page.getByRole('dialog', { name: '拍照', exact: true });
}
test('camera captures, copies, retakes and inserts an editable image on the current PDF page', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const state = ((window as any).cameraTest = {
      streams: [] as MediaStream[],
      constraints: [] as unknown[],
      copied: 0,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: unknown) => {
        state.constraints.push(constraints);
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext('2d')!;
        for (const [i, color] of ['red', 'green', 'blue', 'yellow'].entries()) {
          context.fillStyle = color;
          context.fillRect((i % 2) * 320, Math.floor(i / 2) * 240, 320, 240);
        }
        const stream = canvas.captureStream(10);
        state.streams.push(stream);
        return stream;
      },
    });
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: async (items: ClipboardItem[]) => {
        const blob = await items[0].getType('image/png');
        state.copied = blob.size;
      },
    });
  });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  const dialog = await camera(page);
  await expect(dialog.getByRole('button', { name: '拍照', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(dialog.getByAltText('照片预览')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).cameraTest.streams[0].getTracks()[0].readyState),
    )
    .toBe('ended');
  await dialog.getByRole('button', { name: '复制图片', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('图片已复制');
  expect(await page.evaluate(() => (window as any).cameraTest.copied)).toBeGreaterThan(100);
  await dialog.getByRole('button', { name: '重拍', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '拍照', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '拍照', exact: true }).click();
  await dialog.getByRole('button', { name: '顺时针旋转图片', exact: true }).click();
  await dialog.getByRole('button', { name: '水平镜像', exact: true }).click();
  await dialog.getByRole('button', { name: '垂直镜像', exact: true }).click();
  await expect(dialog.locator('.camera-resolution')).toHaveText('480 × 640');
  const rotatedPreview = (await dialog.locator('.camera-viewfinder').boundingBox())!;
  expect(rotatedPreview.width / rotatedPreview.height).toBeCloseTo(480 / 640, 2);
  await dialog.getByRole('button', { name: '裁剪图片', exact: true }).click();
  await page.getByLabel('裁剪宽度', { exact: true }).fill('50');
  await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
  await expect(dialog.locator('.camera-resolution')).toHaveText('240 × 640');
  const croppedPreview = (await dialog.locator('.camera-viewfinder').boundingBox())!;
  expect(croppedPreview.width / croppedPreview.height).toBeCloseTo(240 / 640, 2);
  const colors = await dialog.getByAltText('照片预览').evaluate((image: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 640;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return [
      Array.from(ctx.getImageData(20, 20, 1, 1).data),
      Array.from(ctx.getImageData(20, 620, 1, 1).data),
    ];
  });
  for (const [index, expected] of [
    [0, 128, 0, 255],
    [255, 0, 0, 255],
  ].entries())
    expected.forEach((value, channel) =>
      expect(Math.abs(colors[index][channel] - value)).toBeLessThanOrEqual(2),
    );
  await dialog.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await stored(page)).pages.map((p: any) => p.images.length))
    .toEqual([0, 1]);
  const image = (await stored(page)).pages[1].images[0];
  expect(image.kind).toBe('image');
  expect(image.width / image.height).toBeCloseTo(240 / 640);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await page.getByLabel('图片对象', { exact: true }).click();
  await expect(page.getByRole('button', { name: '裁剪图片', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).cameraTest.constraints.every((c: any) => c.audio === false && c.video),
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByLabel('图片对象', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '开启触控模式', exact: true }).check();
  await page
    .getByRole('dialog', { name: '设置与笔诊断', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '对象', exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  const object = page.getByLabel('图片对象', { exact: true }),
    original = (await object.boundingBox())!;
  await stroke(cdp, original.x + original.width / 2, original.y + original.height / 2);
  await expect.poll(async () => (await object.boundingBox())!.x).toBeGreaterThan(original.x + 30);
  const handle = page.getByRole('button', { name: '拉伸图片右边', exact: true });
  await expect(handle).toBeVisible();
  const corner = (await handle.boundingBox())!,
    before = (await object.boundingBox())!.width;
  await stroke(cdp, corner.x + corner.width / 2, corner.y + corner.height / 2);
  await expect.poll(async () => (await object.boundingBox())!.width).toBeGreaterThan(before + 30);
});
test('camera handles permission rejection and releases a late permission result after closing', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
  });
  const dialog = await camera(page);
  await expect(dialog.getByRole('alert')).toContainText('摄像头访问被拒绝');
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          (window as any).lateCamera = () => {
            const canvas = document.createElement('canvas');
            const stream = canvas.captureStream();
            (window as any).lateStream = stream;
            resolve(stream);
          };
        }),
    });
  });
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).lateCamera)).toBe('function');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => (window as any).lateCamera());
  await expect
    .poll(() => page.evaluate(() => (window as any).lateStream.getTracks()[0].readyState))
    .toBe('ended');
});
async function touches(
  cdp: CDPSession,
  type: string,
  points: { x: number; y: number; id: number }[],
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ ...p, radiusX: 2, radiusY: 2, force: 0.5 })),
  });
}
test('camera lists front, rear and external devices and adapts constraints without losing the stream on rotation', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const state = ((window as any).cameraDevicesTest = {
      streams: [] as MediaStream[],
      sizes: [] as MediaTrackConstraints[],
      ids: [] as string[],
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => [
        { kind: 'videoinput', deviceId: 'front', label: 'Front camera' },
        { kind: 'videoinput', deviceId: 'rear', label: 'Rear camera' },
        { kind: 'videoinput', deviceId: 'usb', label: 'USB camera' },
        { kind: 'audioinput', deviceId: 'microphone', label: 'Microphone' },
      ],
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: any) => {
        const id = constraints.video.deviceId?.exact ?? 'rear';
        state.ids.push(id);
        const c = document.createElement('canvas');
        c.width = 1920;
        c.height = 1080;
        const context = c.getContext('2d')!;
        context.fillStyle = '#496db1';
        context.fillRect(0, 0, c.width, c.height);
        context.fillStyle = '#f5d897';
        context.fillRect(c.width / 2, 0, c.width / 2, c.height);
        context.fillStyle = 'white';
        context.font = '60px sans-serif';
        context.fillText('1920 × 1080', 80, 120);
        const stream = c.captureStream(10),
          track = stream.getVideoTracks()[0];
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: id });
        track.applyConstraints = async (size) => {
          state.sizes.push(size!);
        };
        state.streams.push(stream);
        return stream;
      },
    });
  });
  const dialog = await camera(page),
    selector = dialog.getByLabel('选择摄像头', { exact: true });
  await expect(selector).toHaveValue('rear');
  await expect(selector.locator('option')).toHaveCount(3);
  await page.setViewportSize({ width: 900, height: 1200 });
  await expect(dialog).toHaveClass(/camera-portrait/);
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraDevicesTest.sizes.at(-1)?.height?.ideal))
    .toBe(1920);
  expect(await page.evaluate(() => (window as any).cameraDevicesTest.streams.length)).toBe(1);
  // Reproduce the Surface driver retaining 1920x1080 despite portrait constraints.
  await expect(dialog.locator('.camera-resolution')).toHaveText('1920 × 1080');
  const portraitPreview = (await dialog.locator('.camera-viewfinder').boundingBox())!;
  expect(portraitPreview.width / portraitPreview.height).toBeCloseTo(16 / 9, 2);
  expect(portraitPreview.width).toBeGreaterThan(650);
  await page.screenshot({ path: '.cache/camera-portrait-output.png' });
  await selector.selectOption('usb');
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraDevicesTest.ids))
    .toEqual(['rear', 'usb']);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).cameraDevicesTest.streams[0].getTracks()[0].readyState),
    )
    .toBe('ended');
  await dialog.getByRole('button', { name: '切换摄像头', exact: true }).click();
  await expect(selector).toHaveValue('front');
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(dialog).not.toHaveClass(/camera-portrait/);
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraDevicesTest.sizes.at(-1)?.width?.ideal))
    .toBe(1920);
  const landscapePreview = (await dialog.locator('.camera-viewfinder').boundingBox())!;
  expect(landscapePreview.width / landscapePreview.height).toBeCloseTo(16 / 9, 2);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).cameraDevicesTest.streams.every(
          (s: MediaStream) => s.getTracks()[0].readyState === 'ended',
        ),
      ),
    )
    .toBe(true);
});
async function stroke(cdp: CDPSession, x: number, y: number) {
  await touches(cdp, 'touchStart', [{ id: 1, x, y }]);
  for (let i = 1; i <= 8; i++)
    await touches(cdp, 'touchMove', [{ id: 1, x: x + i * 8, y: y + i * 2 }]);
  await touches(cdp, 'touchEnd', []);
}
for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
  test(`touch mode is opt-in, draws and erases, and cancels tentative ink for two-finger zoom in ${mode}`, async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: mode, exact: true }).click();
    const cdp = await page.context().newCDPSession(page);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const setting = page.getByRole('checkbox', { name: '开启触控模式', exact: true });
    await expect(setting).not.toBeChecked();
    await page
      .getByRole('dialog', { name: '设置与笔诊断', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    const paper = page.locator('.paper,.reading-paper').first();
    let box = (await paper.boundingBox())!,
      x = box.x + box.width * 0.4,
      y = box.y + Math.min(box.height * 0.3, 270);
    await stroke(cdp, x, y);
    expect((await stored(page)).pages[0].strokes).toHaveLength(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await setting.check();
    await page
      .getByRole('dialog', { name: '设置与笔诊断', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    box = (await paper.boundingBox())!;
    x = box.x + box.width * 0.4;
    y = box.y + Math.min(box.height * 0.3, 270);
    await stroke(cdp, x, y);
    await expect.poll(async () => (await stored(page)).pages[0].strokes.length).toBe(1);
    await page.getByRole('button', { name: '橡皮擦', exact: true }).click();
    await stroke(cdp, x, y);
    await expect.poll(async () => (await stored(page)).pages[0].strokes.length).toBe(0);
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    const before = (await paper.boundingBox())!.width;
    await touches(cdp, 'touchStart', [{ id: 1, x, y }]);
    await touches(cdp, 'touchMove', [{ id: 1, x: x + 5, y }]);
    await touches(cdp, 'touchStart', [
      { id: 1, x: x + 5, y },
      { id: 2, x: x + 100, y },
    ]);
    for (let i = 1; i <= 6; i++)
      await touches(cdp, 'touchMove', [
        { id: 1, x: x + 5 - i * 5, y },
        { id: 2, x: x + 100 + i * 8, y },
      ]);
    await touches(cdp, 'touchEnd', []);
    await expect.poll(async () => (await paper.boundingBox())!.width).toBeGreaterThan(before * 1.2);
    expect((await stored(page)).pages[0].strokes).toHaveLength(0);
    box = (await paper.boundingBox())!;
    x = Math.max(260, box.x + box.width * 0.4);
    y = Math.max(280, box.y + 220);
    await stroke(cdp, x, y);
    await expect.poll(async () => (await stored(page)).pages[0].strokes.length).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(setting).toBeChecked();
  });
}
