import { ProviderTaskError } from './providerTasks';
import { t } from './i18n';

export type NativeReleaseState = 'released' | 'unavailable' | 'unsupported' | 'not-contacted';
let mayHaveModel = false;
export function noteNativeModel(supported = true) {
  mayHaveModel ||= supported;
}

/** Contact only the existing loopback service; never start it or load a model. */
export async function releaseNativeModel(
  signal?: AbortSignal,
  force = false,
): Promise<NativeReleaseState> {
  signal?.throwIfAborted();
  if (!force && !mayHaveModel) return 'not-contacted';
  try {
    const response = await fetch('http://127.0.0.1:8766/models/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release-idle' }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1200)]),
    });
    if (response.status === 429)
      throw new ProviderTaskError('busy', t('已有本地推理正在运行，请稍后重试'));
    if ([404, 405].includes(response.status)) return 'unsupported';
    const data = await response.json();
    if (
      !response.ok ||
      data?.engine !== 'SurfaceTab model lifecycle' ||
      data.ok !== true ||
      data.loaded !== false ||
      typeof data.released !== 'boolean'
    )
      return 'unavailable';
    mayHaveModel = false;
    return 'released';
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProviderTaskError) throw error;
    return 'unavailable';
  }
}
