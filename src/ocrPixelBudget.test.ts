import { expect, it } from 'vitest';
import { createOcrPixelBudget, ocrInputPixels } from './ocrPixelBudget';
it('admits four small images but serializes 4MP images; queued cancellation releases waiters', async () => {
  const take = createOcrPixelBudget(),
    abort = new AbortController();
  const small = await Promise.all(Array.from({ length: 4 }, () => take(1_000_000, abort.signal)));
  let acquired = false;
  const large = take(4_000_000, abort.signal).then((release) => {
    acquired = true;
    return release;
  });
  await Promise.resolve();
  expect(acquired).toBe(false);
  small.forEach((release) => release());
  const release = await large;
  const pending = take(4_000_000, abort.signal),
    rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await rejected;
  release();
  release();
  const final = await take(4_000_000, new AbortController().signal);
  final();
});
it('reads only the PNG header and budgets unknown inputs conservatively', () => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(1000, 16);
  bytes.writeUInt32BE(800, 20);
  expect(ocrInputPixels('data:image/png;base64,' + bytes.toString('base64'))).toBe(800000);
  expect(ocrInputPixels('other')).toBe(4000000);
});
