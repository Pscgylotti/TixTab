const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { zipMembers } = require('./local-tool-zip.cjs');
const revision = 'c685f280914d91a694494588d9f6a376d7917eba';
const requiredSourceFiles = [
  'src/copisteria/pipeline.py',
  'src/copisteria/vocab.py',
  'src/copisteria/instruments.json',
  'src/copisteria/links.json',
  'models/yolo_v7_taxonomy.json',
  'LICENSE',
  'NOTICE',
];
const hasSourceFiles = (directory) =>
  requiredSourceFiles.every((name) => existsSync(path.join(directory, name)));

function createCopistaComponent({ root, resolveModel, command }) {
  root = path.resolve(root);
  const source = path.join(root, 'copista-' + revision);
  const site = path.join(root, 'homr-runtime', 'Lib', 'site-packages');
  const python = path.join(root, 'homr-runtime', 'Scripts', 'python.exe');
  const sourceReady = () => existsSync(path.join(source, '.ready')) && hasSourceFiles(source);
  const ready = () =>
    sourceReady() &&
    existsSync(python) &&
    ['torch', 'torchvision', 'scipy'].every((name) =>
      existsSync(path.join(site, name, '__init__.py')),
    );
  async function prepare(current) {
    if (!existsSync(python)) throw Error('runtime-missing');
    const detector = await resolveModel('copista/detector-28m.pt');
    const evidence = await resolveModel('copista/evidence-2m.pt');
    const archive = await resolveModel('copista/source.zip');
    if (!detector || !evidence || !archive) throw Error('missing-model');
    if (!ready()) {
      if (!sourceReady()) {
        if ((await fs.stat(archive)).size > 4 * 1024 * 1024) throw Error('component-invalid');
        const prefix = 'copisteria-' + revision + '/';
        const members = await zipMembers(
          await fs.readFile(archive),
          (name) =>
            name.startsWith(prefix) &&
            !name.endsWith('/') &&
            (name.startsWith(prefix + 'src/') ||
              name === prefix + 'models/yolo_v7_taxonomy.json' ||
              ['LICENSE', 'NOTICE'].includes(name.slice(prefix.length))),
          16 * 1024 * 1024,
        );
        const stage = path.join(root, '.copista-' + randomUUID());
        const backup = path.join(root, '.copista-backup-' + randomUUID());
        // The existing managed component can predate the taxonomy extraction fix.
        // Validate its replacement before swapping; never leave a partial component marked ready.
        let moved = false,
          installed = false;
        if ([source, stage, backup].some((p) => path.dirname(p) !== root))
          throw Error('component-invalid');
        await fs.mkdir(stage);
        try {
          for (const member of members) {
            if (current.cancelled) throw Error('cancelled');
            const relative = member.name.slice(prefix.length);
            if (relative.split('/').some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p)))
              throw Error('component-invalid');
            const target = path.resolve(stage, relative);
            if (!target.startsWith(stage + path.sep)) throw Error('component-invalid');
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, member.data, { flag: 'wx' });
          }
          if (!hasSourceFiles(stage)) throw Error('component-invalid');
          await command(
            current,
            python,
            [
              '-I',
              '-X',
              'utf8',
              '-c',
              'import sys; sys.path.insert(0,sys.argv[1]); import torch,torchvision,scipy,cv2; from copisteria import pipeline,instruments; from copisteria.vocab import CLASSES; assert len(CLASSES)==270; instruments._load()',
              path.join(stage, 'src'),
            ],
            stage,
          );
          if (current.cancelled) throw Error('cancelled');
          await fs.writeFile(path.join(stage, '.ready'), revision);
          if (existsSync(source)) {
            if ((await fs.lstat(source)).isSymbolicLink()) throw Error('component-invalid');
            await fs.rename(source, backup);
            moved = true;
          }
          try {
            await fs.rename(stage, source);
            installed = true;
          } catch (error) {
            if (moved) await fs.rename(backup, source);
            throw error;
          }
        } finally {
          await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
          if (installed && moved)
            await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
        }
      } else
        await command(
          current,
          python,
          ['-I', '-X', 'utf8', '-c', 'import torch,torchvision,scipy,cv2'],
          root,
        );
    }
    return { python, source, detector, evidence };
  }
  return { ready, prepare };
}
module.exports = { createCopistaComponent };
