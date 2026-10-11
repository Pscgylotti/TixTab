import { t } from './i18n';
export interface ChatAccount {
  id: string;
  email: string;
  name: string;
  signedIn: boolean;
  enabled: boolean;
}
export interface ChatStatus {
  accounts: ChatAccount[];
  active: string;
  storage: 'encrypted' | 'session' | 'error';
  welcome: boolean;
  revoked?: boolean;
}
export interface ChatModel {
  id: string;
  name: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  context?: string;
  pageId?: string;
  pageNumber?: number;
  image?: string;
  file?: { name: string; data: string };
  fileName?: string;
  failed?: boolean;
}
export interface ChatBridge {
  run: (
    request: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
}
const errors: Record<string, string> = {
  desktop: '请使用桌面应用登录 ChatGPT。',
  network: '无法连接 ChatGPT，请检查网络或系统代理后重试。',
  timeout: 'ChatGPT 请求超时，请重试。',
  signin: '请重新登录 ChatGPT。',
  permission: '当前账号尚未授权 TixTab 使用 ChatGPT 订阅额度。',
  denied: '已取消 ChatGPT 授权。',
  identity: 'ChatGPT 登录验证失败，请重新登录。',
  storage: '无法安全读取或保存 ChatGPT 登录，请检查系统凭据存储。',
  eligibility: '当前用户、工作空间或地区不符合 ChatGPT 订阅额度接入条件。',
  unsupported: '当前模型不支持此次请求的部分内容，请移除附件或选择其它模型。',
  limit: 'ChatGPT 使用额度已达上限，请在用量设置中查看。',
  unavailable: '当前账号的 ChatGPT 订阅额度暂时不可用，请稍后重试。',
  'stream-format': '服务没有返回预期的回答流，请检查网络代理后重试。',
  'stream-json': '收到的回答流格式异常，请重试。',
  'empty-response': '服务已结束请求，但没有返回回答文字，请重试或切换模型。',
  models: '当前账号没有返回可用模型，请刷新模型列表或重新登录。',
  incomplete: '回答未完成，已保留收到的内容，请重试。',
  'file-limit': '原 PDF 需小于 50 MB，请改为附加页面。',
  'input-limit': '发送内容过大，请缩小选区或开始新对话。',
  'output-limit': '回答超过大小限制，已保留收到的内容。',
  busy: '请先完成或取消当前 ChatGPT 操作。',
  cancelled: '已停止。',
  invalid: 'ChatGPT 请求无效，请重试。',
};
export const chatError = (code: string) => t(errors[code] || errors.network);
export async function chatRequest<T>(request: Record<string, unknown>): Promise<T> {
  if (!window.surfaceDesktop?.chatgpt) throw new Error('desktop');
  let result;
  try {
    result = await window.surfaceDesktop.chatgpt.run(request);
  } catch {
    throw new Error('network');
  }
  if (!result.ok) throw new Error(result.error || 'network');
  return result.data as T;
}
export function conversationInput(messages: ChatMessage[]) {
  // Failed/incomplete answers are visible locally, but never presented as finished model turns.
  return messages
    .filter((m) => !m.failed)
    .slice(-31)
    .map((m) => ({
      role: m.role,
      text:
        m.fileName && !m.file
          ? `[Previously attached original PDF: ${m.fileName}. The file is not attached to this turn. Use the prior summary, or ask to reattach for unsupported details.]\n${m.text}`
          : m.context
            ? `${m.context}${!m.image && m.context.includes('[Attached page image') ? '\n[The image is no longer attached in this turn. Ask the user to reattach it if needed.]' : ''}\n\nUser question:\n${m.text}`
            : m.text,
      ...(m.image ? { image: m.image } : {}),
      ...(m.file ? { file: m.file } : {}),
    }));
}
