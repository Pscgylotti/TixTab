import { describe, expect, it, vi } from 'vitest';
import { activatePenTarget, registerPenTargets } from './penInteraction';

describe('pen target routing', () => {
  it('prioritizes a link over an overlapping image without loading the image', async () => {
    const image = vi.fn(async () => vi.fn());
    const link = vi.fn();
    const removeImage = registerPenTargets('priority', { kind: 'image', hit: image });
    const removeLink = registerPenTargets('priority', { kind: 'link', hit: async () => link });
    try {
      expect(await activatePenTarget('priority', 10, 20, new AbortController().signal)).toBe(true);
      expect(link).toHaveBeenCalledOnce();
      expect(image).not.toHaveBeenCalled();
    } finally {
      removeLink();
      removeImage();
    }
  });

  for (const reason of ['cancelled', 'unmounted'] as const) {
    it(`discards a pending geometry hit when ${reason}`, async () => {
      let resolve!: (action: () => void) => void;
      const action = vi.fn();
      const abort = new AbortController();
      const remove = registerPenTargets(reason, {
        kind: 'link',
        hit: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      const pending = activatePenTarget(reason, 10, 20, abort.signal);
      if (reason === 'cancelled') abort.abort();
      else remove();
      resolve(action);
      try {
        expect(await pending).toBe(false);
        expect(action).not.toHaveBeenCalled();
      } finally {
        remove();
      }
    });
  }

  it('continues to an image if link metadata is unavailable', async () => {
    const action = vi.fn();
    const removeLink = registerPenTargets('fallback', {
      kind: 'link',
      hit: async () => {
        throw new Error('missing annotations');
      },
    });
    const removeImage = registerPenTargets('fallback', { kind: 'image', hit: async () => action });
    try {
      expect(await activatePenTarget('fallback', 10, 20, new AbortController().signal)).toBe(true);
      expect(action).toHaveBeenCalledOnce();
    } finally {
      removeLink();
      removeImage();
    }
  });
});
