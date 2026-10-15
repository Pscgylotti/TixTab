import { useSyncExternalStore } from 'react';
export type ProviderFeature = 'translation' | 'speech' | 'ocr' | 'formula';
export type ProviderSettingsFeature = ProviderFeature | 'chat';
export type StorageStatus = 'loading' | 'pending' | 'encrypted' | 'session' | 'error';
export interface ProviderProfile {
  url: string;
  model: string;
  voice: string;
  key: string;
  headers: string;
  timeoutSeconds: number;
  fallback: boolean;
  stream: boolean;
  pdfInput?: 'text' | 'file';
}
export interface ProviderRecord {
  selected: string;
  profiles: Record<string, ProviderProfile>;
}
export interface ProviderConfig extends ProviderProfile {
  type: string;
}
export const providerTypes: Record<ProviderSettingsFeature, string[]> = {
  chat: ['llm'],
  translation: ['local', 'local-native', 'local-service', 'google', 'web', 'llm'],
  speech: ['native', 'local', 'system', 'web', 'llm'],
  ocr: ['native', 'local', 'windows-ai', 'tesseract-native', 'texo', 'web', 'llm'],
  formula: ['texo-native', 'texo-cpu', 'texo-gpu', 'unimumer', 'pix2text', 'web', 'llm'],
};
export const googleEndpoint = 'https://translation.googleapis.com/language/translate/v2';
export function defaultProfile(feature: ProviderSettingsFeature, type: string): ProviderProfile {
  return {
    url:
      type === 'google'
        ? googleEndpoint
        : type === 'llm'
          ? ''
          : `http://127.0.0.1:8765/${{ translation: 'translate', speech: 'tts', ocr: 'ocr', formula: 'recognize', chat: 'chat' }[feature]}`,
    model: '',
    voice: 'alloy',
    key: '',
    headers: '',
    timeoutSeconds: feature === 'chat' ? 120 : 15,
    fallback: true,
    stream: feature === 'chat',
    ...(feature === 'chat' ? { pdfInput: 'text' as const } : {}),
  };
}
function publicUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}
export function publicProviderRecord(record: ProviderRecord): ProviderRecord {
  return {
    selected: record.selected,
    profiles: Object.fromEntries(
      Object.entries(record.profiles).map(([type, p]) => [
        type,
        { ...p, url: publicUrl(p.url), key: '', headers: '' },
      ]),
    ),
  };
}
export function normalizeRecord(
  feature: ProviderSettingsFeature,
  raw: unknown,
  fallback: string,
): ProviderRecord {
  const value = raw as Partial<ProviderRecord> | null;
  const selected =
    typeof value?.selected === 'string' && providerTypes[feature].includes(value.selected)
      ? value.selected
      : fallback;
  const profiles: Record<string, ProviderProfile> = {};
  for (const type of providerTypes[feature]) {
    const source = value?.profiles?.[type],
      p = defaultProfile(feature, type);
    if (source && typeof source === 'object') {
      for (const key of ['url', 'model', 'voice', 'key', 'headers'] as const)
        if (typeof source[key] === 'string')
          p[key] = source[key].slice(
            0,
            { url: 2048, model: 256, voice: 128, key: 8192, headers: 16384 }[key],
          );
      if (Number.isFinite(source.timeoutSeconds))
        p.timeoutSeconds = Math.max(2, Math.min(180, source.timeoutSeconds));
      if (typeof source.fallback === 'boolean') p.fallback = source.fallback;
      if (typeof source.stream === 'boolean') p.stream = source.stream;
      if (feature === 'chat' && ['text', 'file'].includes(source.pdfInput ?? ''))
        p.pdfInput = source.pdfInput;
    }
    if (type === 'google') p.url = googleEndpoint;
    profiles[type] = p;
  }
  return { selected, profiles };
}
export function profileOrigin(profile: Pick<ProviderProfile, 'url'>) {
  try {
    return new URL(profile.url).origin;
  } catch {
    return '';
  }
}
export function applyProfilePatch(
  previous: ProviderProfile,
  change: Partial<ProviderProfile>,
  boundOrigin = profileOrigin(previous),
) {
  const next = { ...previous, ...change },
    origin = profileOrigin(next);
  if (change.key !== undefined || change.headers !== undefined) return { profile: next, origin };
  if (change.url !== undefined && origin && boundOrigin && origin !== boundOrigin) {
    next.key = '';
    next.headers = '';
    return { profile: next, origin };
  }
  return { profile: next, origin: origin || boundOrigin };
}
interface Entry {
  record: ProviderRecord;
  status: StorageStatus;
  ready: boolean;
  snapshot: number;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  loading?: Promise<void>;
  writing: Promise<void>;
  revision: number;
  publicJson?: string;
  origins: Record<string, string>;
}
const entries = new Map<ProviderSettingsFeature, Entry>();
function storageKey(feature: ProviderSettingsFeature) {
  return `surfacetab.providers.v1.${feature}`;
}
function emit(e: Entry) {
  e.snapshot++;
  e.listeners.forEach((fn) => fn());
}
function metadata(feature: ProviderSettingsFeature, e: Entry) {
  try {
    const json = JSON.stringify(publicProviderRecord(e.record));
    if (json === e.publicJson) return;
    localStorage.setItem(storageKey(feature), json);
    e.publicJson = json;
  } catch {
    /* Session settings remain usable. */
  }
}
function entry(feature: ProviderSettingsFeature, fallback: string) {
  let e = entries.get(feature);
  if (e) return e;
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(feature)) ?? 'null');
  } catch {
    /* Empty initial record. */
  }
  const desktop = window.surfaceDesktop?.loadProviderSettings;
  e = {
    record: normalizeRecord(feature, saved, fallback),
    status: desktop ? 'loading' : 'session',
    ready: !desktop,
    snapshot: 0,
    listeners: new Set(),
    writing: Promise.resolve(),
    revision: 0,
    origins: {},
  };
  e.origins = Object.fromEntries(
    Object.entries(e.record.profiles).map(([type, p]) => [type, profileOrigin(p)]),
  );
  entries.set(feature, e);
  if (desktop) {
    const current = e;
    e.loading = desktop(feature)
      .then((result) => {
        if (result.data) current.record = normalizeRecord(feature, result.data, fallback);
        current.origins = Object.fromEntries(
          Object.entries(current.record.profiles).map(([type, p]) => [type, profileOrigin(p)]),
        );
        current.status = result.status;
      })
      .catch(() => {
        current.status = 'error';
      })
      .finally(() => {
        current.ready = true;
        metadata(feature, current);
        emit(current);
      });
  }
  return e;
}
async function persist(feature: ProviderSettingsFeature, e: Entry) {
  clearTimeout(e.timer);
  e.timer = undefined;
  await e.loading;
  if (!window.surfaceDesktop?.saveProviderSettings) {
    e.status = 'session';
    emit(e);
    return;
  }
  const revision = e.revision,
    record = structuredClone(e.record);
  const job = e.writing.then(async () => {
    try {
      const result = await window.surfaceDesktop!.saveProviderSettings!(feature, record);
      if (revision === e.revision) {
        e.status = result.status;
        emit(e);
      }
    } catch {
      if (revision === e.revision) {
        e.status = 'error';
        emit(e);
      }
    }
  });
  e.writing = job;
  await job;
}
export function useProviderConfig(feature: ProviderSettingsFeature, fallback: string) {
  const e = entry(feature, fallback);
  useSyncExternalStore(
    (fn) => {
      e.listeners.add(fn);
      return () => {
        e.listeners.delete(fn);
      };
    },
    () => e.snapshot,
  );
  const provider: ProviderConfig = {
    type: e.record.selected,
    ...e.record.profiles[e.record.selected],
  };
  const update = (change: Partial<ProviderProfile>, type = e.record.selected) => {
    if (!e.ready || !providerTypes[feature].includes(type)) return;
    const updated = applyProfilePatch(e.record.profiles[type], change, e.origins[type]);
    e.origins[type] = updated.origin;
    e.record = { selected: type, profiles: { ...e.record.profiles, [type]: updated.profile } };
    e.revision++;
    metadata(feature, e);
    e.status = window.surfaceDesktop?.saveProviderSettings ? 'pending' : 'session';
    emit(e);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      void persist(feature, e);
    }, 350);
  };
  return {
    provider,
    patch: (change: Partial<ProviderProfile>) => update(change),
    selectProvider: (type: string) => update({}, type),
    ready: e.ready,
    storageStatus: e.status,
    save: () => persist(feature, e),
    forget: () => update({ key: '', headers: '' }),
  };
}
