import { afterEach, expect, it, vi } from 'vitest';
import { apiChat, chatApiBody, chatApiError, chatApiIdentity } from './chatApi';
import {
  defaultProfile,
  publicProviderRecord,
  normalizeRecord,
  type ProviderConfig,
} from './providerSettings';

const config = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  ...defaultProfile('chat', 'llm'),
  type: 'llm',
  url: 'https://api.test/v1',
  model: 'small',
  ...extra,
});
afterEach(() => vi.unstubAllGlobals());
it('maps conversation, image and explicit PDF inputs without silently sending unsupported files', () => {
  const turns = [
    { role: 'user' as const, text: 'question' },
    { role: 'assistant' as const, text: 'answer' },
    { role: 'user' as const, text: 'figure', image: 'data:image/png;base64,YQ==' },
    {
      role: 'user' as const,
      text: 'summarize',
      file: { name: 'paper.pdf', data: 'data:application/pdf;base64,YQ==' },
    },
  ];
  expect(() => chatApiBody(config(), turns)).toThrow();
  const body = JSON.parse(chatApiBody(config({ pdfInput: 'file' }), turns));
  expect(body.messages[1]).toEqual({ role: 'assistant', content: 'answer' });
  expect(body.messages[2].content[1]).toEqual({
    type: 'image_url',
    image_url: { url: turns[2].image },
  });
  expect(body.messages[3].content[1]).toEqual({
    type: 'file',
    file: { filename: 'paper.pdf', file_data: turns[3].file!.data },
  });
  expect(() => chatApiBody(config({ model: '' }), [])).toThrow();
  expect(() => chatApiBody(config(), [{ role: 'user', text: 'x'.repeat(24_000_000) }])).toThrow();
});
it('does not persist credentials or use them as history identity', () => {
  const c = config({
    url: 'https://api.test/v1?key=secret#private',
    key: 'secret',
    headers: '{"X-Key":"secret"}',
  });
  expect(chatApiIdentity(c)).toBe('https://api.test/v1/chat/completions:small');
  const publicData = publicProviderRecord(
    normalizeRecord('chat', { selected: 'llm', profiles: { llm: c } }, 'llm'),
  );
  expect(JSON.stringify(publicData)).not.toMatch(/secret|private/);
});
it('supports non-stream JSON with text parts and authentication headers', async () => {
  const fetcher = vi.fn(async (_url: URL, _init: { headers: Headers }) =>
    Response.json({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' world' },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const partial = vi.fn();
  expect(
    await apiChat(
      config({ key: 'key', stream: false }),
      [{ role: 'user', text: 'hi' }],
      new AbortController().signal,
      partial,
    ),
  ).toBe('Hello world');
  expect(fetcher.mock.calls[0][1].headers.get('authorization')).toBe('Bearer key');
  expect(partial).toHaveBeenLastCalledWith('Hello world');
});
it('streams fragmented UTF-8 and retains content delivered with the finish reason', async () => {
  const bytes = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
  );
  let offset = 0;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            if (offset >= bytes.length) c.close();
            else {
              c.enqueue(bytes.slice(offset, offset + 7));
              offset += 7;
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const partial = vi.fn();
  expect(await apiChat(config(), [], new AbortController().signal, partial)).toBe('你好!');
  expect(partial).toHaveBeenLastCalledWith('你好!');
});
it('keeps partial output on a truncated stream and on token-limit JSON', async () => {
  const partial = vi.fn();
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response('data: {"choices":[{"delta":{"content":"received"}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  await expect(apiChat(config(), [], new AbortController().signal, partial)).rejects.toThrow(
    'Incomplete',
  );
  expect(partial).toHaveBeenLastCalledWith('received');
  vi.stubGlobal('fetch', async () =>
    Response.json({ choices: [{ message: { content: 'partial JSON' }, finish_reason: 'length' }] }),
  );
  await expect(apiChat(config(), [], new AbortController().signal, partial)).rejects.toThrow(
    'Incomplete',
  );
  expect(partial).toHaveBeenLastCalledWith('partial JSON');
});
it('maps HTTP failures without displaying response bodies or sensitive network errors', async () => {
  for (const status of [401, 403, 429, 500]) {
    vi.stubGlobal('fetch', async () => new Response('secret request body', { status }));
    const error = await apiChat(config(), [], new AbortController().signal, vi.fn()).catch(
      (e) => e,
    );
    expect(chatApiError(error)).not.toContain('secret');
    expect(chatApiError(error)).not.toBe(chatApiError(new Error('secret URL')));
  }
});
