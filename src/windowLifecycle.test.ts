import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { bindWindowLifecycle } = createRequire(import.meta.url)('../electron/window-lifecycle.cjs');

function fixture() {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const main = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  const popup = () => {
    let destroyed = false;
    const child = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => {
        destroyed = true;
        child.emit('closed');
      }),
    });
    main.webContents.emit('did-create-window', child);
    return child;
  };
  bindWindowLifecycle(main, app);
  return { main, app, popup };
}
it('destroys all auxiliary windows and quits when the editor closes', () => {
  const { main, app, popup } = fixture();
  const first = popup(),
    second = popup();
  first.destroy();
  main.emit('closed');
  expect(first.destroy).toHaveBeenCalledTimes(1);
  expect(second.destroy).toHaveBeenCalledTimes(1);
  expect(app.quit).toHaveBeenCalledTimes(1);
  expect(app.listenerCount('before-quit')).toBe(0);
  expect(popup().destroy).toHaveBeenCalledTimes(1);
});
it('destroys popups before quitting even if their page would prevent closing', () => {
  const { main, app, popup } = fixture();
  const child = popup();
  child.on('close', () => {
    throw Error('must destroy rather than request close');
  });
  app.emit('before-quit');
  expect(child.isDestroyed()).toBe(true);
  main.emit('closed');
  expect(child.destroy).toHaveBeenCalledTimes(1);
});
