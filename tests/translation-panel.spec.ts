import { test, expect } from '@playwright/test';
test('standalone translation edits source, retains draft/results, shares three recent languages and uses real provider routing', async ({
  page,
}) => {
  const calls: any[] = [];
  await page.route('http://127.0.0.1:8766/health', (route) =>
    route.fulfill({
      json: {
        ok: true,
        engine: 'Texo OpenVINO',
        devices: [],
        capabilities: ['hymt2-translation-v1', 'release-idle'],
      },
    }),
  );
  await page.route('http://127.0.0.1:8766/translate-hymt', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({
      json: {
        translation: `Translated ${body.text} -> ${body.target}`,
        encoderDevice: body.device,
        decoderDevice: body.device,
        timing: { totalMs: 12 },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const open = async () => {
    await page.locator('.statusbar').getByRole('button', { name: '页面快捷操作' }).click();
    await page
      .getByRole('dialog', { name: '页面快捷操作' })
      .getByRole('button', { name: '翻译', exact: true })
      .click();
    return page.getByRole('dialog', { name: '翻译界面', exact: true });
  };
  let panel = await open();
  await expect(panel.getByLabel('翻译原文')).toBeVisible();
  await panel.getByLabel('翻译原文').fill('A local translation');
  await panel.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await panel.getByLabel('翻译后端类型').selectOption('hymt2');
  await panel.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await panel
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(panel.locator('.translation-result')).toContainText(
    'Translated A local translation',
  );
  expect(calls[0]).toMatchObject({
    text: 'A local translation',
    backend: 'llama',
    device: 'CPU',
    target: 'zh-CN',
  });
  await panel.getByRole('button', { name: '关闭翻译界面' }).click();
  panel = await open();
  await expect(panel.getByLabel('翻译原文')).toHaveValue('A local translation');
  await expect(panel.locator('.translation-result')).toContainText(
    'Translated A local translation',
  );
  for (const language of ['en', 'ja', 'fr', 'ko'])
    await panel.getByLabel('翻译目标语言').selectOption(language);
  const history = panel.getByRole('group', { name: '最近目标语言' });
  await expect(history.getByRole('button')).toHaveCount(3);
  await history.getByRole('button', { name: 'Français' }).click();
  await expect(panel.getByLabel('翻译目标语言')).toHaveValue('fr');
  await panel.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await panel.getByLabel('翻译后端类型').selectOption('hymt2-openvino');
  await panel.getByLabel('翻译计算设备').selectOption('NPU');
  await panel.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await panel.getByLabel('翻译原文').fill('New source');
  await panel
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(panel.locator('.translation-result')).toContainText('Translated New source -> fr');
  expect(calls.at(-1)).toMatchObject({ backend: 'openvino', device: 'NPU', target: 'fr' });
  await page.setViewportSize({ width: 560, height: 900 });
  await expect(panel).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.reload();
  panel = await open();
  await expect(panel.getByRole('group', { name: '最近目标语言' }).getByRole('button')).toHaveCount(
    3,
  );
});
