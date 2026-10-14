import type { ProviderConfig } from './providerSettings';
import type { conversationInput } from './chatgpt';
import {
  endpoint,
  requestHeaders,
  limitedBytes,
  sseText,
  ProviderInputError,
} from './remoteProvider';
import { providerFetch } from './providerTransport';
import { t } from './i18n';
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES } from './chatAttachments';

type Turn = ReturnType<typeof conversationInput>[number];
export function chatApiIdentity(config: ProviderConfig) {
  try {
    const url = endpoint(config, 'chat');
    return `${url.origin}${url.pathname}:${config.model.trim()}`;
  } catch {
    return 'unconfigured';
  }
}
export function chatApiBody(config: ProviderConfig, turns: Turn[]) {
  if (!config.model.trim()) throw new ProviderInputError(t('请填写 API 模型'));
  const images = turns.flatMap((m) => [...(m.image ? [m.image] : []), ...(m.images || [])]);
  if (
    images.length > MAX_CHAT_IMAGES ||
    images.some((i) => i.length > 3_000_000) ||
    images.reduce((n, i) => n + i.length, 0) > MAX_CHAT_IMAGE_BYTES
  )
    throw new ProviderInputError(t('最多附加六张图片，总大小需小于 12 MB。'));
  const messages = turns.map((m) => {
    if (m.role === 'assistant' || (!m.image && !m.images?.length && !m.file))
      return { role: m.role, content: m.text };
    const content: Record<string, unknown>[] = [{ type: 'text', text: m.text }];
    for (const image of [...(m.image ? [m.image] : []), ...(m.images || [])]) {
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(image))
        throw new ProviderInputError(t('聊天图片格式无效'));
      content.push({ type: 'image_url', image_url: { url: image } });
    }
    if (m.file) {
      if (config.pdfInput !== 'file' || !m.file.data.startsWith('data:application/pdf;base64,'))
        throw new ProviderInputError(t('请在 API 设置中选择支持原 PDF 的发送方式'));
      content.push({ type: 'file', file: { filename: m.file.name, file_data: m.file.data } });
    }
    return { role: m.role, content };
  });
  const body = JSON.stringify({ model: config.model.trim(), messages, stream: config.stream });
  if (new TextEncoder().encode(body).byteLength > 24_000_000)
    throw new ProviderInputError(t('API 请求过大，请改用 PDF 文字或较小的页面附件'));
  return body;
}
export async function apiChat(
  config: ProviderConfig,
  turns: Turn[],
  signal: AbortSignal,
  onPartial: (text: string) => void,
) {
  const timeoutMs = Math.round(Math.max(2, Math.min(180, config.timeoutSeconds)) * 1000);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await providerFetch(
    endpoint(config, 'chat'),
    {
      method: 'POST',
      headers: requestHeaders(config),
      body: chatApiBody(config, turns),
      signal: combined,
    },
    'text',
    timeoutMs,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream'))
    return sseText(response, combined, onPartial);
  const bytes = await limitedBytes(response, 4_000_000, combined);
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (data.error) throw new Error('Invalid API response');
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((p) => p?.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('')
        : '';
  if (!text.trim() || text.length > 100000) throw new Error('Invalid API response');
  combined.throwIfAborted();
  onPartial(text);
  if (choice.finish_reason && !['stop', 'end_turn'].includes(choice.finish_reason))
    throw new Error('Incomplete stream');
  return text;
}
export function chatApiError(error: unknown) {
  if (error instanceof ProviderInputError) return error.message;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.message === 'cancelled') return t('已停止。');
    if (error.name === 'TimeoutError') return t('API 请求超时，请增加超时或重试。');
    if (/^HTTP (401|403)$/.test(error.message)) return t('API 认证失败，请检查密钥和请求头。');
    if (error.message === 'HTTP 429') return t('API 额度或速率已达上限，请检查服务商用量。');
    if (/^HTTP \d{3}$/.test(error.message))
      return t('API 返回 {0}；请检查模型及图片/PDF 输入支持。', error.message);
    if (error.message === 'Incomplete stream') return t('API 回答未完成，已保留收到的内容。');
  }
  return t('API 无法连接或返回格式不正确，请检查接口地址、模型和网络。');
}
