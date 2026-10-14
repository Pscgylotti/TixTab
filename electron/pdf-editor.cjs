const fs = require('node:fs/promises');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { lowerPriority } = require('./low-priority.cjs');
function createPdfEditor({ runtime, backend, temporary, spawnProcess = spawn }) {
  const jobs = new Map();
  const python = path.join(runtime, 'Scripts', 'python.exe');
  async function run(owner, request) {
    if (request?.action === 'cancel') {
      const job = jobs.get(owner);
      if (job && job.id === request.id) job.kill();
      return { ok: !!job };
    }
    const preceding = jobs.get(owner);
    if (preceding?.cancelled) await preceding.finished;
    if (jobs.has(owner)) return { ok: false, error: 'busy' };
    if (
      !request ||
      !['inspect', 'edit', 'batch', 'preview'].includes(request.action) ||
      !Number.isInteger(request.page) ||
      request.page < 0 ||
      !(request.source instanceof Uint8Array) ||
      request.source.length < 5 ||
      request.source.length > 512 * 1024 * 1024 ||
      JSON.stringify({ ...request, source: undefined }).length > 48 * 1024 * 1024
    )
      return { ok: false, error: 'invalid' };
    if (!existsSync(python)) return { ok: false, error: 'runtime-missing' };
    let dir;
    let released;
    const finished = new Promise((resolve) => {
      released = resolve;
    });
    const state = {
      id: request.id,
      finished,
      child: null,
      cancelled: false,
      kill() {
        this.cancelled = true;
        this.child?.kill();
      },
    };
    jobs.set(owner, state);
    try {
      await fs.mkdir(temporary, { recursive: true });
      dir = await fs.mkdtemp(path.join(temporary, 'job-'));
      await fs.writeFile(path.join(dir, 'input.pdf'), request.source);
      await fs.writeFile(
        path.join(dir, 'request.json'),
        JSON.stringify({ ...request, source: undefined }),
        'utf8',
      );
      if (state.cancelled) return { ok: false, error: 'cancelled' };
      await new Promise((resolve, reject) => {
        const child = spawnProcess(python, ['-I', path.join(backend, 'pdf_editor.py'), dir], {
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' },
        });
        state.child = child;
        lowerPriority(child);
        const timeout = setTimeout(() => state.kill(), 120000);
        child.once('error', () => {
          clearTimeout(timeout);
          reject(Error('runtime-missing'));
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          code === 0 && !state.cancelled
            ? resolve()
            : reject(Error(state.cancelled ? 'cancelled' : 'pdf-edit'));
        });
      });
      const resultPath = path.join(dir, 'result.json');
      if ((await fs.stat(resultPath)).size > (request.action === 'preview' ? 64 : 8) * 1024 * 1024)
        throw Error('element-limit');
      const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      if (result.ok && ['edit', 'batch'].includes(request.action)) {
        const file = path.join(dir, 'output.pdf');
        if ((await fs.stat(file)).size > 512 * 1024 * 1024) throw Error('pdf-size');
        result.data.source = new Uint8Array(await fs.readFile(file));
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        error: ['runtime-missing', 'cancelled', 'element-limit', 'pdf-size'].includes(e.message)
          ? e.message
          : 'pdf-edit',
      };
    } finally {
      if (jobs.get(owner) === state) jobs.delete(owner);
      if (dir && path.dirname(dir) === path.resolve(temporary))
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      released();
    }
  }
  return {
    run,
    cancel(owner) {
      jobs.get(owner)?.kill();
    },
    dispose() {
      for (const job of jobs.values()) job.kill();
    },
  };
}
module.exports = { createPdfEditor };
