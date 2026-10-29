const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { lowerPriority } = require('./low-priority.cjs');
const { zipMembers } = require('./local-tool-zip.cjs');
const homrModels = [
  ['segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f', 'segmentation'],
  ['encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903', 'transformer'],
  ['decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903', 'transformer'],
];
function createLocalDocumentTools({ root, backend, resolveModel, spawnProcess = spawn }) {
  root = path.resolve(root);
  let job = null,
    disposed = false;
  const diagnostics = new WeakMap();
  const python = (kind) => path.join(root, kind + '-runtime', 'Scripts', 'python.exe');
  const audiverisRoot = path.join(root, 'audiveris-5.11.0');
  const copista = require('./copista-component.cjs').createCopistaComponent({
    root,
    resolveModel,
    command,
  });
  async function files(directory, depth = 0) {
    if (depth > 16) throw Error('directory-limit');
    const found = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('unsafe');
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await files(item, depth + 1)));
      else if (entry.isFile()) found.push(item);
      if (found.length > 15000) throw Error('directory-limit');
    }
    return found;
  }
  async function audiveris() {
    try {
      const info = JSON.parse(await fs.readFile(path.join(audiverisRoot, '.ready.json'), 'utf8'));
      if (
        ![info.java, info.app].every(
          (v) => typeof v === 'string' && path.resolve(v).startsWith(audiverisRoot + path.sep),
        )
      )
        return null;
      if (!existsSync(info.java) || !existsSync(path.join(info.app, 'Audiveris.cfg'))) return null;
      return info;
    } catch {
      return null;
    }
  }
  function stop(current) {
    current.cancelled = true;
    if (!current.child) return;
    if (process.platform === 'win32' && current.child.pid) {
      const killer = spawnProcess(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(current.child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', () => current.child?.kill());
    } else current.child.kill();
  }
  function command(current, exe, args, cwd, timeout = 600000) {
    if (current.cancelled) return Promise.reject(Error('cancelled'));
    return new Promise((resolve, reject) => {
      const child = spawnProcess(exe, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONNOUSERSITE: '1',
          OMP_NUM_THREADS: '2',
          MKL_NUM_THREADS: '2',
          OPENBLAS_NUM_THREADS: '2',
        },
      });
      current.child = child;
      lowerPriority(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop(current);
      }, timeout);
      const capture = (chunk) => {
        current.logs = (current.logs + chunk.toString()).slice(-12000);
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.once('error', () => {
        clearTimeout(timer);
        current.child = null;
        reject(Error('runtime-missing'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        current.child = null;
        code === 0 && !current.cancelled
          ? resolve()
          : reject(
              Error(timedOut ? 'timeout' : current.cancelled ? 'cancelled' : 'recognition-failed'),
            );
      });
    });
  }
  async function prepareAudiveris(current) {
    if (await audiveris()) return;
    const archive = await resolveModel('audiveris/Audiveris.msi');
    if (!archive) throw Error('missing-model');
    const stage = path.join(root, '.audiveris-' + randomUUID());
    await fs.mkdir(stage, { recursive: true });
    try {
      const script = path
        .join(__dirname, 'extract-audiveris.ps1')
        .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
      await command(
        current,
        path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Archive',
          archive,
          '-Destination',
          stage,
        ],
        root,
        180000,
      );
      const all = await files(stage),
        config = all.find((p) => path.basename(p).toLowerCase() === 'audiveris.cfg');
      if (!config) throw Error('component-invalid');
      const app = path.dirname(config),
        java = path.join(app, '..', 'runtime', 'bin', 'java.exe');
      if (!existsSync(java)) throw Error('component-invalid');
      const info = {
        java: path.join(audiverisRoot, path.relative(stage, java)),
        app: path.join(audiverisRoot, path.relative(stage, app)),
      };
      await fs.writeFile(path.join(stage, '.ready.json'), JSON.stringify(info));
      if (current.cancelled) throw Error('cancelled');
      // Only our fixed managed component directory can be replaced.
      await fs.rm(audiverisRoot, { recursive: true, force: true });
      await fs.rename(stage, audiverisRoot);
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function prepareHomr(current) {
    if (!existsSync(python('homr'))) throw Error('runtime-missing');
    const site = path.join(root, 'homr-runtime', 'Lib', 'site-packages', 'homr');
    if (!existsSync(path.join(site, 'main.py'))) throw Error('runtime-missing');
    for (const [name, directory] of homrModels) {
      if (current.cancelled) throw Error('cancelled');
      const archive = await resolveModel('homr/' + name + '.zip');
      if (!archive) throw Error('missing-model');
      const output = path.join(site, directory, name + '.onnx');
      if (existsSync(output) && (await fs.stat(output)).size > 1000000) continue;
      const members = await zipMembers(
        await fs.readFile(archive),
        (n) => path.basename(n) === name + '.onnx',
        256 * 1024 * 1024,
      );
      if (members.length !== 1) throw Error('component-invalid');
      const temporary = output + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, members[0].data, { flag: 'wx' });
        await fs.rename(temporary, output);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    }
  }
  async function boundedFile(file, limit) {
    if ((await fs.stat(file)).size > limit) throw Error('result-limit');
    return fs.readFile(file);
  }
  return {
    cancel(owner) {
      if (job?.owner === owner) stop(job);
    },
    dispose() {
      disposed = true;
      if (job) stop(job);
    },
    async run(owner, request) {
      if (request?.action === 'cancel') {
        if (job?.owner === owner && (!request.id || request.id === job.id)) stop(job);
        return { ok: true };
      }
      if (request?.action === 'diagnostics')
        return { ok: true, logs: diagnostics.get(owner) || '' };
      if (request?.action === 'status')
        return {
          ok: true,
          data: {
            document: existsSync(python('openvino')),
            homr: existsSync(python('homr')),
            copista: copista.ready(),
            audiveris: !!(await audiveris()),
          },
        };
      if (disposed || job) return { ok: false, error: disposed ? 'cancelled' : 'busy' };
      if (
        !['prepare', 'correct', 'recognize'].includes(request?.action) ||
        !['geometry', 'docaligner', 'uvdoc', 'audiveris', 'homr', 'copista'].includes(
          request?.engine,
        )
      )
        return { ok: false, error: 'invalid' };
      const current = { owner, id: request.id, child: null, cancelled: false, logs: '' };
      job = current;
      let directory;
      try {
        await fs.mkdir(root, { recursive: true });
        if (request.action === 'prepare') {
          if (request.engine === 'audiveris') await prepareAudiveris(current);
          else if (request.engine === 'homr') await prepareHomr(current);
          else if (request.engine === 'copista') await copista.prepare(current);
          else if (!existsSync(python('openvino'))) throw Error('runtime-missing');
          return { ok: true };
        }
        const data = request.image;
        if (
          typeof data !== 'string' ||
          data.length > 24 * 1024 * 1024 ||
          !data.startsWith('data:image/png;base64,')
        )
          throw Error('image-size');
        const bytes = Buffer.from(data.slice(22), 'base64');
        if (
          bytes.length < 33 ||
          bytes.readUInt32BE(0) !== 0x89504e47 ||
          bytes.readUInt32BE(4) !== 0x0d0a1a0a
        )
          throw Error('image-size');
        const width = bytes.readUInt32BE(16),
          height = bytes.readUInt32BE(20);
        if (!width || !height || width * height > 4000000 || Math.max(width, height) > 8192)
          throw Error('image-size');
        directory = await fs.mkdtemp(path.join(root, 'document-job-'));
        await fs.writeFile(path.join(directory, 'input.png'), bytes);
        if (request.action === 'correct') {
          if (
            !['geometry', 'docaligner', 'uvdoc'].includes(request.engine) ||
            !['scan', 'photo', 'auto', 'card', 'book', 'wrinkle', 'manual'].includes(request.mode)
          )
            throw Error('invalid');
          if (!existsSync(python('openvino'))) throw Error('runtime-missing');
          if (!['AUTO', 'CPU', 'GPU', 'NPU'].includes(request.device || 'AUTO'))
            throw Error('invalid');
          const options = request.options || {};
          if (JSON.stringify(options).length > 6000) throw Error('invalid');
          const method = options.method || (request.mode === 'scan' ? 'lines' : 'uvdoc');
          if (
            ![
              'lines',
              'projection',
              'perspective',
              'book',
              'uvdoc',
              'docaligner',
              'manual',
            ].includes(method)
          )
            throw Error('invalid');
          const needsModel = ['uvdoc', 'docaligner'].includes(method);
          if (needsModel && method !== request.engine) throw Error('invalid');
          const model = !needsModel
            ? ''
            : await resolveModel(
                method === 'uvdoc' ? 'uvdoc/inference.onnx' : 'docaligner/fastvit_t8.onnx',
              );
          if (needsModel && !model) throw Error('missing-model');
          await fs.mkdir(path.join(root, 'uvdoc-cache'), { recursive: true });
          await fs.writeFile(
            path.join(directory, 'request.json'),
            JSON.stringify({
              mode: request.mode,
              device: request.device || 'AUTO',
              options: { ...options, method },
            }),
          );
          await command(
            current,
            python('openvino'),
            [
              '-I',
              path.join(backend, 'document_correct.py'),
              directory,
              model || '',
              path.join(root, 'uvdoc-cache'),
            ],
            directory,
          );
          const result = JSON.parse(
            (await boundedFile(path.join(directory, 'result.json'), 1024 * 1024)).toString('utf8'),
          );
          if (!result.ok) return result;
          const png = await boundedFile(path.join(directory, 'output.png'), 24 * 1024 * 1024);
          return {
            ok: true,
            data: { ...result.data, image: 'data:image/png;base64,' + png.toString('base64') },
          };
        }
        if (request.engine === 'audiveris') {
          const component = await audiveris();
          if (!component) throw Error('runtime-missing');
          const output = path.join(directory, 'output');
          await fs.mkdir(output);
          await command(
            current,
            component.java,
            [
              '-Xmx768m',
              '-XX:ActiveProcessorCount=2',
              '-Djava.awt.headless=true',
              '-Duser.home=' + path.join(root, 'audiveris-home'),
              '-cp',
              component.app + path.sep + '*' + path.delimiter + component.app,
              'Audiveris',
              '-batch',
              '-export',
              '-save',
              '-output',
              output,
              '--',
              path.join(directory, 'input.png'),
            ],
            directory,
          );
          const generated = await files(output),
            mxl = generated.find((p) => /\.mxl$/i.test(p));
          if (!mxl) throw Error('no-score');
          const xml = await zipMembers(
            await boundedFile(mxl, 16 * 1024 * 1024),
            (n) => /\.(musicxml|xml)$/i.test(n) && !n.startsWith('META-INF/'),
            4 * 1024 * 1024,
          );
          if (!xml.length) throw Error('no-score');
          return {
            ok: true,
            data: { musicxml: xml[0].data.toString('utf8'), width, height, engine: 'audiveris' },
          };
        }
        if (request.engine === 'copista') {
          const component = await copista.prepare(current);
          await command(
            current,
            component.python,
            [
              '-I',
              '-X',
              'utf8',
              path.join(backend, 'copista_runner.py'),
              directory,
              component.source,
              component.detector,
              component.evidence,
            ],
            directory,
          );
          const result = JSON.parse(
            (await boundedFile(path.join(directory, 'result.json'), 4 * 1024 * 1024)).toString(
              'utf8',
            ),
          );
          if (!result.ok) return result;
          const musicxml = await boundedFile(
            path.join(directory, 'input.musicxml'),
            4 * 1024 * 1024,
          );
          return {
            ok: true,
            data: {
              ...result.data,
              musicxml: musicxml.toString('utf8'),
              width,
              height,
              engine: 'copista',
            },
          };
        }
        if (request.engine !== 'homr') throw Error('invalid');
        await prepareHomr(current);
        await command(
          current,
          python('homr'),
          ['-I', path.join(backend, 'homr_runner.py'), path.join(directory, 'input.png')],
          directory,
        );
        const musicxml = await boundedFile(path.join(directory, 'input.musicxml'), 4 * 1024 * 1024);
        const layout = JSON.parse(
          (await boundedFile(path.join(directory, 'input.staffs.json'), 4 * 1024 * 1024)).toString(
            'utf8',
          ),
        );
        return {
          ok: true,
          data: { musicxml: musicxml.toString('utf8'), ...layout, width, height, engine: 'homr' },
        };
      } catch (error) {
        return {
          ok: false,
          error: current.cancelled
            ? 'cancelled'
            : [
                  'missing-model',
                  'runtime-missing',
                  'image-size',
                  'invalid',
                  'result-limit',
                  'no-score',
                  'timeout',
                  'component-invalid',
                  'device-unavailable',
                  'device-incompatible',
                ].includes(error.message)
              ? error.message
              : 'local-tool-failed',
        };
      } finally {
        diagnostics.set(owner, current.logs);
        if (directory && path.dirname(directory) === root)
          await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        if (job === current) job = null;
      }
    },
  };
}
module.exports = { createLocalDocumentTools };
