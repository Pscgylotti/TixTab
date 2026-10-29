const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { crc32 } = require('node:zlib');
const { createLocalDocumentTools } = require('../electron/local-document-tools.cjs');
const { createCopistaComponent } = require('../electron/copista-component.cjs');
const revision = 'c685f280914d91a694494588d9f6a376d7917eba';
const sourceFiles = {
  'src/copisteria/pipeline.py': '# pipeline fixture',
  'src/copisteria/vocab.py': '# vocab fixture',
  'src/copisteria/instruments.json': '[]',
  'src/copisteria/links.json': '{}',
  'models/yolo_v7_taxonomy.json': JSON.stringify({
    classes: Array.from({ length: 270 }, (_, i) => 'symbol-' + i),
  }),
  LICENSE: 'Apache-2.0',
  NOTICE: 'KobiMusic',
};
async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
}
function sourceZip(files) {
  const locals = [],
    entries = [];
  let offset = 0;
  for (const [relative, content] of Object.entries(files)) {
    const name = Buffer.from('copisteria-' + revision + '/' + relative),
      data = Buffer.from(content);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    entries.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(entries),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length / 2, 8);
  end.writeUInt16LE(entries.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

for (const previousInstall of [false, true]) {
  test(`Copista extracts runtime metadata and validates before publishing (${previousInstall ? 'repair old marked-ready install' : 'fresh install'})`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tixtab-copista-'));
    const source = path.join(root, 'copista-' + revision);
    let probes = 0;
    const component = createCopistaComponent({
      root,
      resolveModel: async (name) => path.join(root, path.basename(name)),
      command: async (_current, _python, args, stage) => {
        probes++;
        assert.deepEqual(args.slice(0, 4), ['-I', '-X', 'utf8', '-c']);
        assert.ok(args[4].includes('from copisteria import pipeline'));
        assert.equal(args[5], path.join(stage, 'src'));
        assert.equal(
          JSON.parse(await fs.readFile(path.join(stage, 'models/yolo_v7_taxonomy.json'))).classes
            .length,
          270,
        );
        await assert.rejects(fs.access(path.join(stage, '.ready')));
      },
    });
    try {
      await writeFiles(root, { 'homr-runtime/Scripts/python.exe': 'fixture' });
      for (const name of ['torch', 'torchvision', 'scipy'])
        await writeFiles(root, { ['homr-runtime/Lib/site-packages/' + name + '/__init__.py']: '' });
      await fs.writeFile(path.join(root, 'source.zip'), sourceZip(sourceFiles));
      if (previousInstall) {
        const incomplete = { ...sourceFiles, '.ready': revision };
        delete incomplete['models/yolo_v7_taxonomy.json'];
        await writeFiles(source, incomplete);
      }
      assert.equal(component.ready(), false);
      await component.prepare({ cancelled: false });
      assert.equal(component.ready(), true);
      for (const [name, content] of Object.entries(sourceFiles))
        assert.equal(await fs.readFile(path.join(source, name), 'utf8'), content);
      await component.prepare({ cancelled: false });
      assert.equal(probes, 1);
      assert.equal(
        (await fs.readdir(root)).some((name) => name.startsWith('.copista-')),
        false,
      );
    } finally {
      assert.equal(path.dirname(root), os.tmpdir());
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const failure of ['metadata', 'import', 'cancel']) {
  test(`Copista leaves the old component intact when repair fails: ${failure}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tixtab-copista-'));
    const source = path.join(root, 'copista-' + revision);
    const component = createCopistaComponent({
      root,
      resolveModel: async (name) => path.join(root, path.basename(name)),
      command: async (current) => {
        if (failure === 'import') throw Error('recognition-failed');
        if (failure === 'cancel') current.cancelled = true;
      },
    });
    try {
      await writeFiles(root, { 'homr-runtime/Scripts/python.exe': 'fixture' });
      await writeFiles(source, { '.ready': revision, 'src/old.py': 'preserved' });
      const files = { ...sourceFiles };
      if (failure === 'metadata') delete files['models/yolo_v7_taxonomy.json'];
      await fs.writeFile(path.join(root, 'source.zip'), sourceZip(files));
      await assert.rejects(
        component.prepare({ cancelled: false }),
        new RegExp(
          failure === 'metadata'
            ? 'component-invalid'
            : failure === 'import'
              ? 'recognition-failed'
              : 'cancelled',
        ),
      );
      assert.equal(component.ready(), false);
      assert.equal(await fs.readFile(path.join(source, 'src/old.py'), 'utf8'), 'preserved');
      assert.equal(
        (await fs.readdir(root)).some((name) => name.startsWith('.copista-')),
        false,
      );
    } finally {
      assert.equal(path.dirname(root), os.tmpdir());
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test('Copista uses the existing Python, returns mapped results and removes per-page caches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tixtab-copista-'));
  const source = path.join(root, 'copista-' + revision);
  const runtime = path.join(root, 'homr-runtime');
  let invocation;
  const tool = createLocalDocumentTools({
    root,
    backend: path.resolve('backend'),
    resolveModel: async (name) => path.join(root, path.basename(name)),
    spawnProcess(exe, args, options) {
      invocation = { exe, args, options };
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      queueMicrotask(async () => {
        const job = options.cwd;
        await fs.writeFile(path.join(job, 'input.musicxml'), '<score-partwise/>');
        await fs.writeFile(
          path.join(job, 'result.json'),
          JSON.stringify({
            ok: true,
            data: {
              systems: [{ x: 0, y: 0, width: 1, height: 1 }],
              noteLocations: { n: { system: 0 } },
            },
          }),
        );
        await fs.writeFile(path.join(job, 'input.feat_v7_2048.npz'), 'temporary detector features');
        c.emit('close', 0);
      });
      return c;
    },
  });
  try {
    await fs.mkdir(source);
    await writeFiles(source, sourceFiles);
    await fs.writeFile(path.join(source, '.ready'), revision);
    await fs.mkdir(path.join(runtime, 'Scripts'), { recursive: true });
    await fs.writeFile(path.join(runtime, 'Scripts', 'python.exe'), 'test');
    for (const dependency of ['torch', 'torchvision', 'scipy']) {
      const site = path.join(runtime, 'Lib', 'site-packages', dependency);
      await fs.mkdir(site, { recursive: true });
      await fs.writeFile(path.join(site, '__init__.py'), '');
    }
    const owner = {};
    assert.equal((await tool.run(owner, { action: 'status' })).data.copista, true);
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47);
    png.writeUInt32BE(0x0d0a1a0a, 4);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(100, 20);
    const result = await tool.run(owner, {
      action: 'recognize',
      engine: 'copista',
      image: 'data:image/png;base64,' + png.toString('base64'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.engine, 'copista');
    assert.equal(result.data.noteLocations.n.system, 0);
    assert.equal(invocation.exe, path.join(runtime, 'Scripts', 'python.exe'));
    assert.deepEqual(invocation.args.slice(0, 3), ['-I', '-X', 'utf8']);
    assert.equal(invocation.options.windowsHide, true);
    assert.equal(
      (await fs.readdir(root)).some((name) => name.startsWith('document-job-')),
      false,
    );
  } finally {
    tool.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
});
