/** Drain every active owner before releasing canvases/workers. The lazy
 * iterator only decodes images when a lane is ready, including across pages. */
export async function runBitmapJobs(
  jobs: Iterable<(lane: number) => Promise<void>> | AsyncIterable<(lane: number) => Promise<void>>,
  count: number,
  signal: AbortSignal,
) {
  const iterator =
    Symbol.asyncIterator in jobs ? jobs[Symbol.asyncIterator]() : jobs[Symbol.iterator]();
  let failed = false,
    error: unknown;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(4, count)) }, async (_, lane) => {
      while (!failed && !signal.aborted) {
        try {
          const item = await iterator.next();
          if (item.done || failed || signal.aborted) return;
          await item.value(lane);
        } catch (cause) {
          if (!failed) {
            failed = true;
            error = cause;
          }
        }
      }
    }),
  );
  await iterator.return?.();
  signal.throwIfAborted();
  if (failed) throw error;
}
