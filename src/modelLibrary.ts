import { t } from './i18n';
export type ModelAction = 'install' | 'verify' | 'remove';
export type ModelState = {
  id: string;
  bundled: boolean;
  downloaded: boolean;
  source: 'bundled' | 'downloaded' | 'missing';
  verified: { source: string; at: number } | null;
};
export type ModelProgress = { id: string; action: ModelAction; done: number; total: number };
export type ModelLibraryBridge = {
  list: () => Promise<ModelState[]>;
  run: (id: string, action: ModelAction) => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<boolean>;
  onProgress: (callback: (value: ModelProgress) => void) => () => void;
};
class MissingModelError extends Error {
  readonly code = 'missing-model';
}
export async function requireLocalModels(ids: string[]) {
  const bridge = typeof window === 'undefined' ? undefined : window.surfaceDesktop?.models;
  if (!bridge) return;
  const states = await bridge.list();
  if (ids.some((id) => !states.some((m) => m.id === id && m.source !== 'missing')))
    throw new MissingModelError(t('本地模型尚未安装，请在设置的“本地模型管理”中按需下载。'));
}
