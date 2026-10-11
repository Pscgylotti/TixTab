import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { createRuntimeInstaller } = createRequire(import.meta.url)(
  '../electron/runtime-installer.cjs',
);
const root = resolve(process.argv[2] || '.cache/runtime-install-validation');
const stages = [],
  owner = {};
const installer = createRuntimeInstaller({
  root,
  backend: resolve('backend'),
  fetch,
  notify: (_owner, value) => {
    if (stages.at(-1)?.stage !== value.stage) {
      stages.push(value);
      console.log(value.id, value.stage);
    }
  },
});
const results = [];
try {
  for (const id of ['openvino', 'speech']) {
    const start = Date.now(),
      result = await installer.install(owner, id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.installed, true);
    results.push({ id, milliseconds: Date.now() - start, ...result.data });
    const before = stages.filter((s) => s.stage === 'download').length;
    assert.equal((await installer.install(owner, id)).ok, true);
    assert.equal(
      stages.filter((s) => s.stage === 'download').length,
      before,
      'Ready runtime downloaded again',
    );
  }
  await mkdir('.cache', { recursive: true });
  await writeFile(
    '.cache/runtime-install-validation.json',
    JSON.stringify(
      { results, stages, basePythonPreinstalled: false, usedPythonLauncher: false },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  installer.dispose();
}
