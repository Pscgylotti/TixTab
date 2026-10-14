import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Real controller/worker protocol with authored WAV fixtures; never opens a microphone.
const require = createRequire(import.meta.url);
const { createNeuralDictation } = require('../electron/neural-dictation.cjs');
const { createModelLibrary } = require('../electron/model-library.cjs');
const catalog = require('../electron/model-catalog.json');
const root = join(process.env.APPDATA, 'surfacetab/model-library/v1');
const output = resolve('.cache/asr-lifecycle-native-round3.json');
const cacheRoot = resolve('.cache/asr-round3-npu-external-cache');
const samples = resolve('.cache/asr-round3-samples');
const owner = {};
const workers = [];
const sessions = [];
const models = createModelLibrary({ root, bundled: resolve('public/models'), catalog, fetch });
const service = createNeuralDictation({
  backend: resolve('backend'),
  runtime: join(process.env.USERPROFILE, '.surfacetab/asr-runtime'),
  modelRoot: root,
  bundled: resolve('public/models'),
  models,
  system: { cancel() {}, dispose() {} },
  spawnProcess(exe, args, options) {
    const isWorker = args.includes(resolve('backend/asr_worker.py'));
    const child = spawn(exe, isWorker ? [...args, '--capture-wav', samples] : args, {
      ...options,
      env: { ...options.env, LOCALAPPDATA: cacheRoot },
    });
    if (isWorker) {
      const record = { launcherPid: child.pid, started: Date.now(), events: [] };
      workers.push(record);
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            // No fixture waveform samples or audio are written to the protocol log.
            if (event.event !== 'level') record.events.push({ ...event, at: Date.now() });
          } catch {
            /* Other output is not protocol data. */
          }
        }
      });
      child.once('close', (code, signal) => {
        record.exited = Date.now();
        record.exitCode = code;
        record.signal = signal;
      });
    }
    return child;
  },
});

async function transcribe(language, stopAfter = Infinity) {
  const began = Date.now();
  const start = await service.run(owner, {
    action: 'start',
    engine: 'whisper-small',
    language,
    device: 'NPU',
    idleReleaseSeconds: 30,
  });
  assert.ok(start.ok, JSON.stringify(start));
  const record = { id: start.data.id, language, began, text: '', levels: 0, stopRequested: false };
  while (Date.now() - began < 90000) {
    const next = await service.run(owner, { action: 'read', id: record.id });
    assert.ok(next.ok, JSON.stringify(next));
    const data = next.data;
    assert.equal(data.error, '', JSON.stringify(data));
    if (data.device) assert.equal(data.device, 'NPU');
    record.text += data.text || '';
    if (data.ready && !record.ready) record.ready = Date.now();
    if (data.level > 0) record.levels++;
    if (record.ready && !record.stopRequested && Date.now() - record.ready >= stopAfter) {
      assert.ok((await service.run(owner, { action: 'stop' })).ok);
      record.stopRequested = true;
      record.stopped = Date.now();
    }
    if (data.done) {
      record.done = Date.now();
      assert.ok(record.text.length > 3, JSON.stringify(record));
      assert.ok(record.levels > 2, JSON.stringify(record));
      sessions.push(record);
      console.log(
        JSON.stringify({
          session: sessions.length,
          language,
          readyMs: record.ready - began,
          elapsedMs: record.done - began,
          stopRequested: record.stopRequested,
          text: record.text,
        }),
      );
      return record;
    }
  }
  throw Error('ASR protocol did not complete within 90 seconds');
}

const sources = [
  'backend/asr_worker.py',
  'backend/asr_lifecycle.py',
  'backend/native_asr.py',
  'electron/neural-dictation.cjs',
  'scripts/verify-asr-lifecycle.mjs',
  'package.json',
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(name))
          .digest('hex'),
      ]),
    ),
  );
const before = await hashes();
try {
  const build = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(
    build.build.extraFiles
      .find((entry) => entry.from === 'backend')
      .filter.includes('asr_lifecycle.py'),
  );
  const status = await service.run(owner, { action: 'status' });
  assert.ok(status.data.installed);
  assert.ok(status.data.devices.includes('NPU'));
  const first = await transcribe('en-US');
  assert.match(first.text, /library/i);
  await delay(1000); // Distinct sessions and language switch, same model identity.
  const second = await transcribe('zh-CN', 3600);
  assert.ok(second.stopRequested);
  assert.match(second.text, /[图圖][书書][馆館]/);
  assert.equal(workers.length, 1, 'Language switch must reuse the resident Whisper worker');
  assert.equal(workers[0].events.filter((event) => event.event === 'loaded').length, 1);
  console.log('Waiting for the real 30-second idle deadline after the final session');
  const deadline = second.done + 37000;
  while (!workers[0].exited && Date.now() < deadline) await delay(100);
  assert.ok(workers[0].exited, 'Worker must release after its configured idle deadline');
  assert.equal(workers[0].exitCode, 0);
  const idleAfterDoneMs = workers[0].exited - second.done;
  assert.ok(idleAfterDoneMs >= 29500 && idleAfterDoneMs <= 35000, String(idleAfterDoneMs));
  const third = await transcribe('en-US');
  assert.match(third.text, /library/i);
  assert.equal(workers.length, 2, 'Expired worker must be replaced on the next session');
  assert.equal(workers[1].events.filter((event) => event.event === 'loaded').length, 1);
  assert.ok((await service.run(owner, { action: 'idle-policy', idleReleaseSeconds: 1800 })).ok);
  assert.deepEqual(await hashes(), before, 'Sources changed during validation');
  await mkdir('.cache', { recursive: true });
  const result = {
    timestamp: new Date().toISOString(),
    sources: before,
    fixtureManifest: JSON.parse(await readFile(join(samples, 'samples.json'), 'utf8')),
    cacheRoot,
    idleAfterDoneMs,
    policyRestoredToSeconds: 1800,
    sessions,
    workers,
    limitations: [
      'Authored TTS fixtures, not real microphone accuracy validation',
      'No CPU, energy, or whole-process-tree claim from protocol timing',
      '30-second test policy; production default remains 1800 seconds',
    ],
  };
  await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, workers: workers.length, idleAfterDoneMs, passed: true }));
} finally {
  service.dispose();
  models.dispose();
}
