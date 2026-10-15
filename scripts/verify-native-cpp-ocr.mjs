import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
const { createNativeOcr } = createRequire(import.meta.url)('../electron/native-ocr.cjs');
const root = await mkdtemp(join(tmpdir(), 'tixtab-native-real-')),
  owner = new EventEmitter();
const service = createNativeOcr({
  executable: resolve('.cache/native-ocr/runtime/tixtab-ocr.exe'),
  workingRoot: root,
  resolveModel: async (name) =>
    name === 'tesseract-openvino/best.traineddata'
      ? resolve('.cache/tesseract-openvino/eng-best.traineddata')
      : resolve('public/models', name),
});
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="220"><rect width="1100" height="220" fill="white"/><g font-family="Arial" font-size="36" fill="black"><text x="40" y="75">Native Tesseract preserves word spacing.</text><text x="40" y="140">Search highlights use exact line and word boxes.</text></g></svg>';
const image =
  'data:image/png;base64,' + (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
try {
  for (const variant of ['fast', 'mixed-fast', 'best']) {
    const id = 'real-' + variant;
    const opened = await service.run(owner, { action: 'open', id, variant, count: 1 });
    assert.equal(opened.ok, true, opened.error);
    for (let index = 0; index < 2; index++) {
      const result = await service.run(owner, { action: 'recognize', id, image });
      assert.equal(result.ok, true, result.error);
      assert.match(result.data.text, /Native Tesseract preserves word spacing/);
      assert.equal(result.data.lines.length, 2);
      assert.ok(result.data.lines[0].words.length >= 5);
      for (const line of result.data.lines)
        for (const word of line.words) {
          assert.equal(word.polygon.length, 8);
          assert.ok(word.polygon.every(Number.isFinite));
        }
      console.log(
        JSON.stringify({
          variant,
          index,
          lines: result.data.lines.length,
          words: result.data.lines.reduce((n, l) => n + l.words.length, 0),
          timing: result.data.timing,
        }),
      );
    }
    assert.equal((await service.run(owner, { action: 'close', id })).ok, true);
    assert.deepEqual(await readdir(root), []);
  }
} finally {
  await service.dispose();
  await rm(root, { recursive: true, force: true });
}
