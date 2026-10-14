// Windows offline dictation; owned helper only, no recording file or network.
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const validMicrophone = (id) =>
  id === undefined ||
  id === '' ||
  (typeof id === 'string' && /^winmm:[A-Za-z0-9+/=]{1,4096}$/.test(id));
function createDictation({ helper, spawnProcess = spawn, platform = process.platform }) {
  let job = null;
  let listing = null;
  const stop = (owner) => {
    if (!job || job.done || (owner && job.owner !== owner)) return;
    const current = job;
    current.done = true;
    current.ready = false;
    clearTimeout(current.timer);
    current.process.stdin?.write('\n');
    current.kill = setTimeout(() => current.process.kill(), 800);
    current.wake?.();
  };
  const launch = (args) =>
    spawnProcess(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helper,
        ...args,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
  return {
    async run(owner, r) {
      if (platform !== 'win32') return { ok: false, error: 'desktop' };
      if (r?.action === 'microphones') {
        if (listing) return listing;
        listing = new Promise((resolve) => {
          const child = launch(['-Microphones']);
          child.stdout.setEncoding('utf8');
          let output = '';
          const complete = (result) => {
            clearTimeout(timer);
            resolve(result);
          };
          const timer = setTimeout(() => {
            child.kill();
            complete({ ok: false, error: 'microphone' });
          }, 10000);
          child.stdout.on('data', (chunk) => {
            output += chunk.toString('utf8');
            if (output.length > 65536) {
              child.kill();
              complete({ ok: false, error: 'microphone' });
            }
          });
          child.once('error', () => complete({ ok: false, error: 'microphone' }));
          child.once('close', (code) => {
            try {
              const value = JSON.parse(output.trim());
              if (code !== 0 || !Array.isArray(value.microphones)) throw Error('invalid');
              const microphones = value.microphones
                .filter(
                  (m) =>
                    validMicrophone(m.id) &&
                    m.id &&
                    typeof m.name === 'string' &&
                    m.name.length <= 256,
                )
                .slice(0, 64);
              complete({
                ok: true,
                data: {
                  microphones,
                  defaultId: microphones.some((m) => m.id === value.defaultId)
                    ? value.defaultId
                    : '',
                },
              });
            } catch {
              complete({ ok: false, error: 'microphone' });
            }
          });
        }).finally(() => {
          listing = null;
        });
        return listing;
      }
      if (r?.action === 'stop') {
        stop(owner);
        return { ok: true, data: true };
      }
      if (r?.action === 'start') {
        if (!validMicrophone(r.microphone)) return { ok: false, error: 'invalid' };
        if (job && !job.done) return { ok: false, error: 'busy' };
        if (!['zh-CN', 'zh-TW', 'en-US', 'en-GB'].includes(r.language))
          return { ok: false, error: 'language' };
        if (job) {
          clearTimeout(job.expiry);
          clearTimeout(job.kill);
          job.process.kill();
        }
        const current = {
          id: crypto.randomUUID(),
          owner,
          process: launch([
            '-Language',
            r.language,
            ...(r.microphone ? ['-Microphone', r.microphone] : []),
          ]),
          done: false,
          ready: false,
          error: '',
          text: '',
          level: 0,
          microphoneName: '',
          buffer: '',
          wake: null,
          timer: null,
          kill: null,
          expiry: null,
          reading: false,
        };
        job = current;
        current.process.stdin?.on('error', () => {});
        const finish = () => {
          clearTimeout(current.timer);
          clearTimeout(current.kill);
          current.done = true;
          current.wake?.();
          if (job === current)
            current.expiry = setTimeout(() => {
              if (job === current) job = null;
            }, 30000);
        };
        current.process.stdout.on('data', (chunk) => {
          current.buffer += chunk.toString('utf8');
          if (current.buffer.length > 65536) {
            current.error = 'microphone';
            stop(owner);
            return;
          }
          let at;
          while ((at = current.buffer.indexOf('\n')) >= 0) {
            const line = current.buffer.slice(0, at).trim();
            current.buffer = current.buffer.slice(at + 1);
            if (line === 'READY') current.ready = true;
            else if (line.startsWith('INPUT '))
              current.microphoneName = Buffer.from(line.slice(6), 'base64')
                .toString('utf8')
                .slice(0, 256);
            else if (line.startsWith('LEVEL ') && !current.done)
              current.level = Math.max(0, Math.min(100, Number(line.slice(6)) || 0));
            else if (line.startsWith('TEXT ') && !current.done) {
              const text = Buffer.from(line.slice(5), 'base64').toString('utf8');
              current.text += (current.text ? '\n' : '') + text.slice(0, 8000);
              if (current.text.length > 16000) stop(owner);
            } else if (line.startsWith('ERROR '))
              current.error = ['language', 'microphone-missing'].includes(line.slice(6))
                ? line.slice(6)
                : 'microphone';
            current.wake?.();
          }
        });
        current.process.once('error', () => {
          current.error = 'microphone';
          finish();
        });
        current.process.once('close', () => {
          if (!current.ready && !current.error) current.error = 'microphone';
          finish();
        });
        current.timer = setTimeout(() => stop(owner), 120000);
        return { ok: true, data: { id: current.id } };
      }
      if (r?.action === 'read') {
        const current = job;
        if (!current || current.owner !== owner || current.id !== r.id || current.reading)
          return { ok: false, error: 'cancelled' };
        current.reading = true;
        try {
          if (!current.done && !current.text)
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 200);
              current.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          const text = current.text;
          current.text = '';
          return {
            ok: true,
            data: {
              text,
              level: current.level,
              ready: current.ready,
              done: current.done,
              error: current.error,
              microphoneName: current.microphoneName,
            },
          };
        } finally {
          current.wake = null;
          current.reading = false;
        }
      }
      return { ok: false, error: 'invalid' };
    },
    cancel: stop,
    dispose() {
      stop();
      if (job) {
        clearTimeout(job.kill);
        clearTimeout(job.expiry);
        job.process.kill();
        job = null;
      }
    },
  };
}
module.exports = { createDictation, validMicrophone };
