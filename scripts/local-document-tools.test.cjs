const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLocalDocumentTools } = require('../electron/local-document-tools.cjs');
const { audioPermission } = require('../electron/local-media-permission.cjs');
const { zipMembers } = require('../electron/local-tool-zip.cjs');
test('only audio media permission is accepted, including permission preflight', () => {
  assert.equal(audioPermission('media', { mediaTypes: ['audio'] }), true);
  assert.equal(audioPermission('media', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(audioPermission('media', { mediaTypes: [] }), false);
  assert.equal(audioPermission('media', { mediaType: 'audio' }, true), true);
  assert.equal(audioPermission('media', { mediaType: 'video' }, true), false);
  assert.equal(audioPermission('display-capture', { mediaTypes: ['audio'] }), false);
});
test('owned cancellation kills only its own worker, waits for cleanup and releases job storage', async () => {
  const base = path.resolve('.cache/local-document-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'owned-'));
  assert.ok(root.startsWith(base + path.sep));
  let child,
    spawned,
    kill = 0;
  let started;
  const ready = new Promise((r) => (started = r));
  const spawnProcess = (exe, args, options) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 912345;
    c.kill = () => {
      kill++;
      setImmediate(() => c.emit('close', 1));
    };
    if (path.basename(exe).toLowerCase() === 'taskkill.exe') {
      kill++;
      setImmediate(() => {
        child.emit('close', 1);
        c.emit('close', 0);
      });
      return c;
    }
    child = c;
    spawned = { exe, args, options };
    started();
    return c;
  };
  const tool = createLocalDocumentTools({
    root,
    backend: path.resolve('backend'),
    resolveModel: async () => null,
    spawnProcess,
  });
  const owner = {},
    other = {};
  try {
    await fs.mkdir(path.join(root, 'openvino-runtime', 'Scripts'), { recursive: true });
    await fs.writeFile(path.join(root, 'openvino-runtime', 'Scripts', 'python.exe'), 'stub');
    const bytes = Buffer.alloc(33);
    bytes.writeUInt32BE(0x89504e47, 0);
    bytes.writeUInt32BE(0x0d0a1a0a, 4);
    bytes.writeUInt32BE(1, 16);
    bytes.writeUInt32BE(1, 20);
    const job = tool.run(owner, {
      action: 'correct',
      engine: 'uvdoc',
      mode: 'scan',
      id: 'owned',
      image: 'data:image/png;base64,' + bytes.toString('base64'),
    });
    await ready;
    assert.equal(spawned.options.windowsHide, true);
    assert.equal(spawned.options.env.OMP_NUM_THREADS, '2');
    await tool.run(other, { action: 'cancel', id: 'owned' });
    assert.equal(kill, 0);
    assert.equal((await tool.run(other, { action: 'prepare', engine: 'uvdoc' })).error, 'busy');
    await tool.run(owner, { action: 'cancel', id: 'owned' });
    assert.equal((await job).error, 'cancelled');
    assert.equal(kill, 1);
    assert.equal(
      (await fs.readdir(root)).some((n) => n.startsWith('document-job-')),
      false,
    );
    assert.equal((await tool.run(owner, { action: 'prepare', engine: 'uvdoc' })).ok, true);
  } finally {
    tool.dispose();
    assert.ok(path.resolve(root).startsWith(base + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('ZIP reader rejects invalid archives and oversized directory counts', async () => {
  await assert.rejects(zipMembers(Buffer.from('bad'), () => true));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(15001, 10);
  await assert.rejects(
    zipMembers(end, () => true),
    /archive-limit/,
  );
});
