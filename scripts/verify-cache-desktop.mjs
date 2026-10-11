import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { verifyCacheUi } from './verify-cache-ui.mjs';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const fixture = await mkdtemp(join(tmpdir(), 'surfacetab-cache-desktop-'));
const base = join(fixture, 'SurfaceTab'),
  cache = join(base, 'openvino-cache'),
  blob = join(cache, 'fixture.blob'),
  sentinel = join(cache, 'personal.txt');
await mkdir(cache, { recursive: true });
await writeFile(blob, 'compiled fixture');
await writeFile(sentinel, 'preserve');
await chmod(blob, 0o444);
for (const name of ['documents', 'model-library', 'openvino-runtime']) {
  await mkdir(join(base, name));
  await writeFile(join(base, name, 'sentinel'), 'preserve');
}
const app = await electron.launch({
  executablePath: resolve(process.argv[2] || `release/${version}/win-unpacked/SurfaceTab.exe`),
  args: [],
  env: {
    ...process.env,
    LOCALAPPDATA: fixture,
    SURFACETAB_DEV: '0',
    SURFACETAB_PROFILE: join(fixture, 'profile'),
  },
  timeout: 60000,
});
let holder;
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await verifyCacheUi(page);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '磁盘缓存管理', exact: true }).click();
  await page.getByRole('button', { name: '统计缓存', exact: true }).click();
  const card = page.locator('[data-cache-id=texo-compiled]');
  await expect(card).toContainText('1 个文件');
  await expect(card).toContainText('保留 1 项其它数据');
  // A separate real Python process owns the same normal shared residency lease.
  holder = spawn(
    'python',
    [
      '-u',
      '-c',
      "import sys;sys.path.insert(0,sys.argv[1]);from cache_lease import acquire_cache_lease;lease=acquire_cache_lease();print('ready',flush=True);input();lease.close()",
      resolve('backend'),
    ],
    {
      env: { ...process.env, LOCALAPPDATA: fixture },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Lease fixture did not start')), 5000);
    holder.stdout.once('data', (data) => {
      clearTimeout(timeout);
      assert.match(data.toString(), /ready/);
      resolve();
    });
    holder.once('error', reject);
  });
  await card.getByRole('button').click();
  await page.getByRole('button', { name: '确认清理缓存', exact: true }).click();
  await expect(page.locator('.cache-manager [role=status]')).toHaveText(
    '缓存正在使用，请先结束任务或释放其它窗口的模型后重试。',
    { timeout: 35000 },
  );
  await access(blob);
  const closed = once(holder, 'exit');
  holder.stdin.end('\n');
  await closed;
  holder = null;
  await page.getByRole('button', { name: '统计缓存', exact: true }).click();
  await card.getByRole('button').click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await access(blob);
  await card.getByRole('button').click();
  await page.getByRole('button', { name: '确认清理缓存', exact: true }).click();
  await expect(page.locator('.cache-manager [role=status]')).toHaveText(
    '缓存已清理；再次使用时按需重新生成。',
    { timeout: 35000 },
  );
  await assert.rejects(access(blob));
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
  for (const name of ['documents', 'model-library', 'openvino-runtime'])
    assert.equal(await readFile(join(base, name, 'sentinel'), 'utf8'), 'preserve');
  await page.getByRole('button', { name: '统计缓存', exact: true }).click();
  await expect(card.getByRole('button')).toBeDisabled();
  await page.setViewportSize({ width: 560, height: 900 });
  assert.deepEqual(
    await page.locator('.cache-manager').evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el),
          v = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
        return r.width > 6 &&
          r.height > 6 &&
          r.bottom > 0 &&
          r.top < innerHeight &&
          v &&
          v.slice(0, 3).every((n) => n > 170) &&
          (v.length < 4 || v[3] > 0.3)
          ? [el.className]
          : [];
      }),
    ),
    [],
  );
  await page.screenshot({ path: 'test-results/packaged-cache-night-portrait.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Actual packaged cache helper / readonly fixture deletion / cross-process residency refusal / confirmation cancellation / unknown files and document preservation / night portrait: verified; renderer errors: none',
  );
  console.log('Fixture only:', fixture);
} finally {
  holder?.kill();
  await app.close();
}
