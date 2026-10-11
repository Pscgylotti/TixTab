/** Browser model-cache leases coordinate this origin's updated windows. Native
 * model residency additionally owns an OS handle across processes. */
const name = 'surfacetab-model-cache-v1';
export async function withModelCacheUse<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? await navigator.locks.request(name, { mode: 'shared', signal }, work)
    : await work();
}
export async function withCacheMaintenance<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (!navigator.locks) throw new Error('当前浏览器不支持跨窗口缓存保护');
  return await navigator.locks.request(name, { mode: 'exclusive', signal }, work);
}
