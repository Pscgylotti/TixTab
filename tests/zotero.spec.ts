import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
test('Zotero browsing, search, group collection, tabs, association, dedup and reload', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Zotero linked document', { x: 50, y: 700, font, size: 20 });
  const bytes = Array.from(await doc.save());
  await page.addInitScript((bytes) => {
    const state = { requests: [] as any[], cancel: 0 };
    Object.assign(window, { zoteroTest: state });
    const item = {
      key: 'PARENT12',
      title: 'A Zotero paper',
      author: 'Test Author',
      date: '2026',
      type: 'journalArticle',
      pdf: false,
      filename: 'paper.pdf',
      children: 1,
    };
    Object.assign(window, {
      surfaceDesktop: {
        onFullscreen: () => () => {},
        zotero: {
          cancel: async () => {
            state.cancel++;
            return true;
          },
          run: async (r: any) => {
            state.requests.push(r);
            let data: any;
            if (r.action === 'libraries')
              data = [
                { id: 'users/0', name: '' },
                { id: 'groups/12', name: 'Research Group' },
              ];
            if (r.action === 'collections')
              data = { rows: [{ key: 'COLLECT1', name: 'Reading', parent: null }], more: false };
            if (r.action === 'items') data = { rows: [item], more: false };
            if (r.action === 'children')
              data = {
                rows: [
                  { ...item, key: 'ATTACH12', title: 'paper.pdf', type: 'attachment', pdf: true },
                ],
                more: false,
              };
            if (r.action === 'pdf')
              data = {
                filename: 'paper.pdf',
                bytes: new Uint8Array(bytes),
                source: {
                  library: r.library,
                  key: 'ATTACH12',
                  parentKey: 'PARENT12',
                  serverId: 'test-local',
                  title: 'A Zotero paper',
                },
              };
            if (r.action === 'bibtex') data = '@article{paper}';
            return { ok: true, data, serverId: 'test-local' };
          },
        },
      },
    });
  }, bytes);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const original = await page.getByRole('tab').count();
  await page.getByRole('button', { name: '打开 Zotero 资料库', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Zotero 资料库', exact: true });
  await expect(modal.locator('.zotero-item')).toHaveCount(1);
  await page.getByRole('treeitem', { name: 'Research Group', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Reading', exact: true }).last().click();
  await page.getByLabel('搜索 Zotero 文献').fill('multi line');
  await modal.getByRole('button', { name: '搜索', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).zoteroTest.requests.some(
          (r: any) =>
            r.action === 'items' &&
            r.library === 'groups/12' &&
            r.collection === 'COLLECT1' &&
            r.query === 'multi line',
        ),
      ),
    )
    .toBe(true);
  await modal.locator('.zotero-item').click();
  await modal.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
  await expect(modal.getByRole('status')).toHaveText('BibTeX 已复制');
  await modal.locator('.zotero-attachment').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(original + 1);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Zotero linked document');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Zotero linked document');
  await page.getByRole('button', { name: '打开 Zotero 资料库', exact: true }).click();
  await expect(page.locator('.zotero-current')).toContainText('A Zotero paper');
  await page.getByRole('treeitem', { name: 'Research Group', exact: true }).click();
  await page.locator('.zotero-item').click();
  await page.locator('.zotero-attachment').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(original + 1);
  // Association survives the user-facing project export as well as IndexedDB.
  const save = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const project = await save;
  const stream = await project.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(JSON.parse(Buffer.concat(chunks).toString()).zotero).toMatchObject({
    key: 'ATTACH12',
    library: 'groups/12',
    parentKey: 'PARENT12',
    serverId: 'test-local',
  });
});
test('Zotero offline guidance, English, night portrait and no background polling', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let count = 0;
    Object.assign(window, {
      getZoteroCalls: () => count,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        zotero: {
          run: async () => {
            count++;
            return { ok: false, error: 'disabled' };
          },
          cancel: async () => true,
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open Zotero library', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Zotero library', exact: true });
  await expect(modal.getByRole('status')).toContainText('Allow other applications');
  await page.setViewportSize({ width: 560, height: 900 });
  expect(
    await modal.evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el),
          c = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
        return r.width > 6 &&
          r.height > 6 &&
          s.visibility !== 'hidden' &&
          c &&
          c.slice(0, 3).every((n) => n > 170) &&
          (c.length < 4 || c[3] > 0.3)
          ? [el.className]
          : [];
      }),
    ),
  ).toEqual([]);
  expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Close Zotero', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/zotero-night-portrait.png' });
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).getZoteroCalls())).toBe(1);
});

test('native-style collection tree keeps hierarchy, keyboard focus, filtering and cached group navigation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('surfacetab.locale', 'en');
    localStorage.setItem('surfacetab.night', 'true');
    const requests: any[] = [];
    Object.assign(window, { zoteroTreeRequests: requests });
    const folders = [
      { key: 'AGENT001', name: 'Agent', parent: null },
      { key: 'ARCH0001', name: 'Arch', parent: null },
      { key: 'ATTENT01', name: 'Attention', parent: 'ARCH0001' },
      { key: 'FLOW0001', name: 'Flow Matching', parent: 'ARCH0001' },
      { key: 'MEMORY01', name: 'Memory', parent: 'ARCH0001' },
      { key: 'TOKEN001', name: 'Tokenizer', parent: 'ARCH0001' },
      { key: 'TRANS001', name: 'Transformer', parent: 'ARCH0001' },
      { key: 'METHOD01', name: 'Methods', parent: 'ATTENT01' },
    ];
    const titles = [
      'Autoregressive Video Generation with Versatile Memory',
      'BindWeave: Subject-Consistent Video Generation',
      'Captain Cinema: Towards Short Movie Generation',
      'Decoupled Video Generation with a Chain of Thoughts',
      'Error Analyses of Auto-Regressive Video Diffusion',
      'Gen-L-Video: Multi-Text to Long Video Generation',
      'Genie: Generative Interactive Environments',
      'Helios: Real-Time Long Video Generation',
      'Long-Context Autoregressive Video Modeling',
      'Lumina-Video: Efficient and Flexible Video Generation',
      'Magic 1-For-1: Generating One Minute Videos',
      'Mind the Time: Temporally-Controlled Multi-Event Video',
    ];
    Object.assign(window, {
      surfaceDesktop: {
        onFullscreen: () => () => {},
        zotero: {
          cancel: async () => true,
          run: async (r: any) => {
            requests.push(r);
            let data;
            if (r.action === 'libraries')
              data = [
                { id: 'users/0', name: '' },
                { id: 'groups/12', name: 'matrix_team' },
              ];
            else if (r.action === 'collections')
              data = {
                rows:
                  r.library === 'groups/12'
                    ? r.start
                      ? [{ key: 'LATE0001', name: 'Late folder', parent: 'ARCH0001' }]
                      : folders
                    : [{ key: 'READ0001', name: 'Reading', parent: null }],
                more: r.library === 'groups/12' && !r.start,
              };
            else if (r.action === 'items')
              data = {
                rows: titles.map((title, i) => ({
                  key: 'PAPER00' + i,
                  title,
                  author: ['Deng et al.', 'Li et al.', 'Bruce et al.', 'Wang et al.'][i % 4],
                  date: '2026',
                  type: 'journalArticle',
                  pdf: false,
                  filename: 'paper.pdf',
                  children: 1,
                })),
                more: false,
              };
            else data = { rows: [], more: false };
            return { ok: true, data, serverId: 'tree-fixture' };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Zotero library', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Zotero collection tree' }),
    arch = tree.getByRole('treeitem', { name: 'Arch', exact: true }),
    group = tree.getByRole('treeitem', { name: 'matrix_team', exact: true });
  await expect(tree.getByRole('treeitem', { name: 'My library', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await tree.getByRole('button', { name: 'Expand matrix_team', exact: true }).click();
  await expect(arch).toBeVisible();
  await expect(group).toHaveAttribute('aria-selected', 'false');
  expect(
    await page.evaluate(
      () => (window as any).zoteroTreeRequests.filter((r: any) => r.action === 'items').length,
    ),
  ).toBe(1);
  await group.click();
  await expect(group).toHaveAttribute('aria-selected', 'true');
  await expect(arch).toHaveAttribute('aria-expanded', 'false');
  await arch.focus();
  await page.keyboard.press('ArrowRight');
  const attention = tree.getByRole('treeitem', { name: 'Attention', exact: true });
  await expect(attention).toHaveAttribute('aria-level', '3');
  await page.keyboard.press('ArrowRight');
  await expect(attention).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toHaveAttribute(
    'aria-level',
    '4',
  );
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(attention).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(attention).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => page.evaluate(() => (window as any).zoteroTreeRequests.at(-1).collection))
    .toBe('ATTENT01');
  await page.getByLabel('Filter collections', { exact: true }).fill('Methods');
  await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Flow Matching', exact: true })).toHaveCount(0);
  await page.getByLabel('Filter collections', { exact: true }).fill('');
  await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toHaveCount(0);
  await tree.getByRole('button', { name: 'More collections', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'Late folder', exact: true })).toHaveAttribute(
    'aria-level',
    '3',
  );
  const count = await page.evaluate(
    () => (window as any).zoteroTreeRequests.filter((r: any) => r.action === 'collections').length,
  );
  await tree.getByRole('button', { name: 'Collapse matrix_team', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand matrix_team', exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).zoteroTreeRequests.filter((r: any) => r.action === 'collections').length,
    ),
  ).toBe(count);
  await tree.getByRole('button', { name: 'Expand Attention', exact: true }).click();
  await expect(page.locator('.zotero-item')).toHaveCount(12);
  await page.screenshot({ path: 'test-results/zotero-native-tree-landscape.png' });
  await page.setViewportSize({ width: 560, height: 900 });
  await expect(tree).toBeInViewport();
  expect(
    await page.locator('.zotero-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.getByRole('button', { name: 'Hide collections pane', exact: true }).click();
  await expect(tree).toBeHidden();
  await page.getByRole('button', { name: 'Show collections pane', exact: true }).click();
  await expect(tree).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/zotero-native-tree-portrait.png' });
});
