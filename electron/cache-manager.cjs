const { spawn } = require('node:child_process');
const path = require('node:path');
const catalog = require('./cache-catalog.json');
function createCacheManager({ fetch: request = globalThis.fetch, runner = runHelper } = {}) {
  let active = null;
  const known = new Set(catalog.items.map((item) => item.id));
  async function nativeIdle(signal) {
    let response;
    try {
      response = await request('http://127.0.0.1:8766/health', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error?.cause?.code === 'ECONNREFUSED') return;
      throw new Error('unavailable');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('legacy-service');
    }
    if (
      !response.ok ||
      data.engine !== 'Texo OpenVINO' ||
      !data.capabilities?.includes('cache-lease-v1')
    )
      throw new Error('legacy-service');
    response = await request('http://127.0.0.1:8766/models/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release-idle' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
    if (response.status === 429) throw new Error('busy');
    try {
      data = await response.json();
    } catch {
      throw new Error('unavailable');
    }
    if (
      !response.ok ||
      data.engine !== 'SurfaceTab model lifecycle' ||
      data.loaded !== false ||
      data.ok !== true
    )
      throw new Error('unavailable');
  }
  async function perform(owner, action, id = '', token = '') {
    if (active) return { ok: false, error: 'busy' };
    if (
      (action !== 'list' && action !== 'clear') ||
      (action === 'clear' && (!known.has(id) || !/^[a-f0-9]{64}$/.test(token)))
    )
      return { ok: false, error: 'invalid' };
    const controller = new AbortController(),
      deadline = setTimeout(() => controller.abort(), 30000);
    active = { owner, controller };
    try {
      if (action === 'clear') await nativeIdle(controller.signal);
      controller.signal.throwIfAborted();
      const result = await runner(action, id, token, controller.signal);
      controller.signal.throwIfAborted();
      if (result?.ok === true && action === 'list') {
        if (
          !Array.isArray(result.rows) ||
          result.rows.length !== known.size ||
          new Set(result.rows.map((row) => row?.id)).size !== known.size ||
          result.rows.some(
            (row) =>
              !known.has(row?.id) ||
              (!row.error &&
                (!Number.isSafeInteger(row.bytes) ||
                  row.bytes < 0 ||
                  !Number.isSafeInteger(row.files) ||
                  row.files < 0 ||
                  !/^[a-f0-9]{64}$/.test(row.token))),
          )
        )
          throw new Error('failed');
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        error: controller.signal.aborted
          ? 'cancelled'
          : ['busy', 'legacy-service', 'unavailable'].includes(error?.message)
            ? error.message
            : 'failed',
      };
    } finally {
      clearTimeout(deadline);
      active = null;
    }
  }
  return {
    list: (owner) => perform(owner, 'list'),
    clear: (owner, id, token) => perform(owner, 'clear', id, token),
    cancel: (owner) => {
      if (active?.owner !== owner) return false;
      active.controller.abort();
      return true;
    },
    dispose: () => active?.controller.abort(),
  };
}
function runHelper(action, id, token, signal) {
  return new Promise((resolve, reject) => {
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const helper = path.join(
      __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'),
      'cache-helper.ps1',
    );
    const child = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helper,
        '-Action',
        action,
        '-Id',
        id,
        '-Token',
        token,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '',
      settled = false;
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > 64000) child.kill();
    });
    child.once('error', (error) => {
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (settled) return;
      if (signal.aborted || code !== 0) {
        reject(new Error('failed'));
        return;
      }
      try {
        resolve(JSON.parse(output.replace(/^\uFEFF/, '')));
      } catch (error) {
        reject(error);
      }
    });
  });
}
module.exports = { createCacheManager, runHelper };
