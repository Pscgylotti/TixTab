import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { createWindowsAiOcr } = createRequire(import.meta.url)('../electron/windows-ai-ocr.cjs');
it('cancel retires the busy model process, rejects pending inference and removes temporary PNGs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tixtab-winocr-'));
  const owner = new EventEmitter(),
    child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  let killed = 0;
  child.stdin.write = (line: string) => {
    if (JSON.parse(line).action === 'open')
      queueMicrotask(() => child.stdout.emit('data', '{"ok":true}\n'));
  };
  child.kill = () => {
    killed++;
    child.emit('exit', 0);
    child.emit('close', 0);
  };
  const controller = createWindowsAiOcr({
    executable: process.execPath,
    workingRoot: root,
    spawn: () => child,
  });
  try {
    expect(await controller.run(owner, { action: 'open', id: 'cancel-test' })).toEqual({
      ok: true,
    });
    const bytes = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(10, 16);
    bytes.writeUInt32BE(10, 20);
    const job = controller.run(owner, {
      action: 'recognize',
      id: 'cancel-test',
      image: 'data:image/png;base64,' + bytes.toString('base64'),
    });
    await new Promise((r) => setTimeout(r, 15));
    const duplicate = await controller.run(owner, {
      action: 'recognize',
      id: 'cancel-test',
      image: 'invalid',
    });
    expect(duplicate.error).toBe('windows-ai-busy');
    await controller.run(owner, { action: 'close', id: 'cancel-test' });
    expect((await job).ok).toBe(false);
    expect(killed).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(owner.listenerCount('destroyed')).toBe(0);
  } finally {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
