import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url),
  { createNeuralDictation } = require('../electron/neural-dictation.cjs'),
  { createModelLibrary } = require('../electron/model-library.cjs'),
  catalog = require('../electron/model-catalog.json');
const root = join(process.env.APPDATA, 'surfacetab/model-library/v1'),
  owner = {},
  results = [];
let sample = 'zh';
const models = createModelLibrary({ root, bundled: resolve('public/models'), catalog, fetch });
const service = createNeuralDictation({
  backend: resolve('backend'),
  runtime: join(process.env.USERPROFILE, '.surfacetab/asr-runtime'),
  modelRoot: root,
  bundled: resolve('public/models'),
  models,
  system: { cancel() {}, dispose() {} },
  spawnProcess: (exe, args, options) =>
    spawn(
      exe,
      args.includes(resolve('backend/asr_worker.py'))
        ? [...args, '--capture-wav', resolve('.cache/asr-samples')]
        : args,
      options,
    ),
});
async function transcribe(engine, language, device, stopAfter = Infinity) {
  sample = language === 'zh-CN' ? 'zh' : 'en';
  const begun = Date.now(),
    start = await service.run(owner, { action: 'start', engine, language, device });
  assert.ok(start.ok, JSON.stringify(start));
  let text = '',
    levels = 0,
    stopped = false,
    readyAt = 0,
    actual = '';
  while (Date.now() - begun < 90000) {
    const next = await service.run(owner, { action: 'read', id: start.data.id });
    assert.ok(next.ok);
    const d = next.data;
    assert.equal(d.error, '');
    actual = d.device || actual;
    if (d.ready && !readyAt) readyAt = Date.now();
    if (d.level > 0) levels++;
    text += d.text || '';
    if (readyAt && !stopped && Date.now() - readyAt > stopAfter) {
      stopped = true;
      await service.run(owner, { action: 'stop' });
    }
    if (d.done) {
      assert.ok(text.length > 3);
      assert.ok(levels > 2);
      return {
        engine,
        language,
        device: actual,
        stopFlushed: stopped,
        text,
        elapsedSeconds: (Date.now() - begun) / 1000,
      };
    }
  }
  throw Error('timeout');
}
try {
  const status = await service.run(owner, { action: 'status' });
  assert.ok(status.data.installed);
  assert.ok(status.data.devices.includes('NPU'));
  results.push(await transcribe('sensevoice-small', 'zh-CN', 'CPU', 4800));
  results.push(await transcribe('whisper-small', 'en-US', 'NPU'));
  // Same Whisper process, new language, with a final utterance still in flight.
  results.push(await transcribe('whisper-small', 'zh-CN', 'NPU', 4800));
  assert.match(results[1].text, /gold/i);
  assert.match(results[2].text, /时间/);
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/asr-worker-0233.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  service.dispose();
  models.dispose();
}
