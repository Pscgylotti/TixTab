import english from './locales/en.json';
import type { ChatMessage } from './chatgpt';

export const summaryPrompt =
  '请先总结这份 PDF 的主题、主要结论、方法和关键公式，并注明对应页码。随后列出值得进一步讨论的问题。';
export const svgPrompt =
  '请根据以下描述生成一个可直接插入 PDF 的 SVG 矢量图。返回完整的 svg 代码块，使用 viewBox、透明背景和清晰可读的文字。仅使用 SVG 基础形状与 presentation attributes；不使用脚本、foreignObject、外部链接、图片、CSS 样式表或动画。描述：';

/** Only migrate the exact legacy generated prefixes; preserve ordinary user messages. */
export function compactChatMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'user' || message.instruction !== undefined) return message;
  for (const instruction of [summaryPrompt, english[summaryPrompt]]) {
    if (message.text === instruction)
      return { ...message, text: '', instruction, action: 'summary' };
  }
  for (const instruction of [svgPrompt, english[svgPrompt]]) {
    if (message.text.startsWith(instruction + '\n')) {
      return {
        ...message,
        text: message.text.slice(instruction.length + 1),
        instruction,
        action: 'svg',
      };
    }
  }
  return message;
}
