import { expect, it } from 'vitest';
import { runBitmapJobs } from './bitmapOcrPool';
it('bounds parallel owners, schedules lazily across pages and drains after an error', async () => {
  let active = 0,
    peak = 0,
    started = 0;
  const done: number[] = [];
  async function* jobs() {
    for (let i = 0; i < 8; i++)
      yield async () => {
        started++;
        peak = Math.max(peak, ++active);
        try {
          await new Promise((r) => setTimeout(r, i === 0 ? 15 : 2));
          if (i === 1) throw new Error('failed');
          done.push(i);
        } finally {
          active--;
        }
      };
  }
  await expect(runBitmapJobs(jobs(), 2, new AbortController().signal)).rejects.toThrow('failed');
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(started).toBe(2);
  expect(done).toEqual([0]);
});
it('cancellation stops new work and waits for active owners', async () => {
  const abort = new AbortController();
  let started = 0,
    completed = 0;
  const jobs = Array.from({ length: 12 }, () => async () => {
    started++;
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    completed++;
  });
  await expect(runBitmapJobs(jobs, 4, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(started).toBe(4);
  expect(completed).toBe(4);
});
