import { expect, it } from 'vitest';
import { attachmentPages, checkChatImages } from './chatAttachments';
import { conversationInput } from './chatgpt';
import { chatApiBody } from './chatApi';
import { defaultProfile } from './providerSettings';
import { compactChatMessage, summaryPrompt, svgPrompt } from './chatPrompts';
import { createRequire } from 'node:module';
const { validateInput } = createRequire(import.meta.url)('../electron/chatgpt.cjs');

it('accepts ordered page ranges and rejects invalid or oversized batches without expansion', () => {
  expect(attachmentPages('1, 3-4', 8)).toEqual([0, 2, 3]);
  expect(attachmentPages('2，2 3', 8)).toEqual([1, 2]);
  for (const value of ['', '0', '9', '3-1', '1,2,3,4', '1-999999999', '1.5', 'a'])
    expect(() => attachmentPages(value, 8)).toThrow();
});
it('sends three page images and standalone images to both backends with bounded input', () => {
  const image = 'data:image/jpeg;base64,AA==';
  const turns = conversationInput([
    {
      id: 'u',
      role: 'user',
      text: 'Compare',
      context: '[PDF page 1]\n[PDF page 2]\n[PDF page 3]',
      image,
      images: [image, image, image],
    },
  ]);
  expect(
    validateInput({ model: 'm', messages: turns }).input[0].content.filter(
      (c: any) => c.type === 'input_image',
    ),
  ).toHaveLength(4);
  const config = { ...defaultProfile('chat', 'llm'), type: 'llm' as const, model: 'm' };
  expect(
    JSON.parse(chatApiBody(config, turns)).messages[0].content.filter(
      (c: any) => c.type === 'image_url',
    ),
  ).toHaveLength(4);
  expect(() =>
    validateInput({
      model: 'm',
      messages: [{ role: 'user', text: 'x', images: Array(7).fill(image) }],
    }),
  ).toThrow();
  expect(() =>
    validateInput({ model: 'm', messages: [{ role: 'user', text: 'x', images: 'invalid' }] }),
  ).toThrow();
  expect(() => checkChatImages(Array(7).fill(image))).toThrow();
  expect(() => checkChatImages(Array(6).fill('a'.repeat(2_100_000)))).toThrow();
});
it('marks unavailable past image attachments and bounds old page context', () => {
  const turns = conversationInput([
    { id: 'old', role: 'user', text: 'Before', context: 'a'.repeat(40000) },
    { id: 'answer', role: 'assistant', text: 'Answer' },
    {
      id: 'new',
      role: 'user',
      context: '[Attached image: figure.png]',
      imageNames: ['figure.png'],
      text: 'b'.repeat(40000),
    },
  ]);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toContain('no longer attached');
});
it('keeps visible user text separate from internal instructions for both transports and stored history', () => {
  const user = {
    id: 'u',
    role: 'user' as const,
    text: 'Draw a triangle',
    instruction: svgPrompt,
    reading: 'currentPage: 5; no page content attached; ask for missing content',
    action: 'svg' as const,
  };
  const turns = conversationInput([user, { id: 'a', role: 'assistant', text: 'Answer' }]);
  expect(user.text).toBe('Draw a triangle');
  expect(turns[0].text).toContain(svgPrompt);
  expect(turns[0].text).toContain('currentPage: 5');
  expect(turns[1].text).toBe('Answer');
  expect(
    validateInput({ model: 'm', messages: turns.slice(0, 1) }).input[0].content[0].text,
  ).toContain(svgPrompt);
  const config = { ...defaultProfile('chat', 'llm'), type: 'llm' as const, model: 'm' };
  expect(chatApiBody(config, turns)).toContain('currentPage: 5');
  const summary = compactChatMessage({
    id: 's',
    role: 'user',
    text: summaryPrompt,
    fileName: 'doc.pdf',
  });
  expect(summary.text).toBe('');
  expect(summary.action).toBe('summary');
  expect(conversationInput([summary])[0].text).toContain('not attached to this turn');
  expect(conversationInput([summary])[0].text).toContain(summaryPrompt);
  expect(
    compactChatMessage({ id: 'old', role: 'user', text: svgPrompt + '\nMy diagram' }).text,
  ).toBe('My diagram');
  expect(compactChatMessage(user)).toBe(user);
});
