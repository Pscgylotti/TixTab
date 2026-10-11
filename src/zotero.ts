import { t } from './i18n';
import type { ZoteroSource } from './zoteroSource';
export type { ZoteroSource } from './zoteroSource';
export type ZoteroItem = {
  key: string;
  title: string;
  author: string;
  date: string;
  type: string;
  pdf: boolean;
  filename: string;
  children: number;
};
export type ZoteroCollection = { key: string; name: string; parent: string | null };
export type ZoteroRequest = {
  action: 'libraries' | 'collections' | 'items' | 'children' | 'pdf' | 'bibtex' | 'reveal';
  library?: string;
  serverId?: string;
  key?: string;
  parentKey?: string;
  query?: string;
  start?: number;
  collection?: string;
};
export type ZoteroBridge = {
  run: (
    request: ZoteroRequest,
  ) => Promise<{ ok: boolean; error?: string; data?: unknown; serverId?: string }>;
  cancel: () => Promise<boolean>;
};
const errors: Record<string, string> = {
  offline: '无法连接 Zotero。请启动 Zotero 后重试。',
  disabled: '请在 Zotero 设置 → 高级中开启“允许本机上的其他应用程序与 Zotero 通信”。',
  missing: '附件尚未下载、已移动或无法读取。请先在 Zotero 中打开该附件。',
  changed: 'Zotero 资料库已切换，请重新连接。',
  unsupported: '当前 Zotero 版本不支持此接口，请升级 Zotero。',
  'too-large': '文件或响应过大。PDF 附件上限为 256 MiB。',
  'not-pdf': '此附件不是可读取的本地 PDF。',
  busy: 'Zotero 操作正在进行，请稍候。',
  cancelled: '操作已取消或超时。',
  invalid: 'Zotero 请求无效。',
  response: 'Zotero 返回了异常响应，请重试或升级 Zotero。',
};
export async function zoteroRequest<T>(
  request: ZoteroRequest,
): Promise<{ data: T; serverId: string }> {
  const bridge = window.surfaceDesktop?.zotero;
  if (!bridge) throw new Error(t('Zotero 联动请使用桌面应用。'));
  let result;
  try {
    result = await bridge.run(request);
  } catch {
    throw new Error(t(errors.offline));
  }
  if (!result.ok) throw new Error(t(errors[result.error || 'response'] || errors.response));
  return { data: result.data as T, serverId: result.serverId || '' };
}
