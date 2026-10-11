import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  defaultProfile,
  publicProviderRecord,
  normalizeRecord,
  applyProfilePatch,
  type ProviderConfig,
} from './providerSettings';
import {
  endpoint,
  requestHeaders,
  remoteText,
  remoteSpeech,
  checkProviderConnection,
  providerError,
  ProviderInputError,
  destination,
} from './remoteProvider';
const config = (type = 'web', fields: Partial<ProviderConfig> = {}): ProviderConfig => ({
  type,
  ...defaultProfile('translation', type),
  url: 'https://api.test/v1/chat/completions',
  model: 'small-model',
  ...fields,
});
afterEach(() => vi.unstubAllGlobals());
describe('provider profiles and remote requests', () => {
  it('separates profiles and strips secrets and URL credentials/query from plaintext metadata', () => {
    const record = normalizeRecord(
      'translation',
      {
        selected: 'llm',
        profiles: {
          llm: {
            ...config('llm'),
            url: 'https://user:password@api.test/v1?key=query-secret#private',
            key: 'key-secret',
            headers: '{"x-api-key":"header-secret"}',
          },
          web: config('web', { key: 'other' }),
        },
      },
      'local',
    );
    const clean = JSON.stringify(publicProviderRecord(record));
    for (const secret of ['password', 'query-secret', 'key-secret', 'header-secret', 'other'])
      expect(clean).not.toContain(secret);
    expect(record.profiles.llm.key).toBe('key-secret');
    expect(record.profiles.web.key).toBe('other');
    expect(record.selected).toBe('llm');
    expect(normalizeRecord('formula', { selected: 'wrong' }, 'texo-native').selected).toBe(
      'texo-native',
    );
  });
  it('keeps same-origin credentials, clears on a different origin and remembers binding through invalid drafts', () => {
    const previous = config('web', {
      url: 'https://one.test/v1',
      key: 'private',
      headers: '{"X-Key":"private"}',
    });
    expect(applyProfilePatch(previous, { url: 'https://one.test/other' }).profile.key).toBe(
      'private',
    );
    const invalid = applyProfilePatch(previous, { url: '' });
    expect(invalid.profile.key).toBe('private');
    const changed = applyProfilePatch(
      invalid.profile,
      { url: 'https://two.test/v1' },
      invalid.origin,
    );
    expect(changed.profile.key).toBe('');
    expect(changed.profile.headers).toBe('');
    expect(applyProfilePatch(previous, { url: 'http://one.test/v1' }).profile.key).toBe('');
  });
  it('expands root/prefixed v1 bases and preserves complete custom URLs', () => {
    expect(endpoint(config('llm', { url: 'https://api.test' }), 'translation').href).toBe(
      'https://api.test/v1/chat/completions',
    );
    expect(endpoint(config('llm', { url: 'https://api.test/proxy/v1/' }), 'speech').href).toBe(
      'https://api.test/proxy/v1/audio/speech',
    );
    expect(
      endpoint(config('llm', { url: 'https://api.test/custom/chat?revision=1' }), 'ocr').href,
    ).toBe('https://api.test/custom/chat?revision=1');
    expect(destination(config('web', { url: 'https://api.test/ocr?key=secret' }), 'ocr')).toBe(
      'https://api.test/ocr',
    );
    for (const c of [
      config('web', { url: 'file:///x' }),
      config('web', { url: 'https://user:secret@api.test' }),
      config('local-service', { url: 'https://remote.test' }),
    ])
      expect(() => endpoint(c, 'translation')).toThrow(ProviderInputError);
  });
  it('validates custom headers and sends Google key in headers rather than URL', async () => {
    for (const headers of ['[1]', '{"Cookie":"session"}', '{"X-Key":"a\\nb"}', '{"Host":"x"}'])
      expect(() => requestHeaders(config('web', { headers }))).toThrow(ProviderInputError);
    expect(() => requestHeaders(config('web', { key: 'a\nb' }))).toThrow(ProviderInputError);
    vi.stubGlobal(
      'DOMParser',
      class {
        parseFromString() {
          return { documentElement: { textContent: 'hello' } };
        }
      },
    );
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ translatedText: 'hello' })));
    vi.stubGlobal('fetch', fetch);
    const result = await remoteText(
      config('google', {
        url: 'https://translation.googleapis.com/language/translate/v2',
        key: 'private-key',
        headers: '{"X-Project":"custom"}',
      }),
      'translation',
      'text',
      'en',
      new AbortController().signal,
    );
    expect(result.text).toBe('hello');
    expect(String(fetch.mock.calls[0][0])).not.toContain('private-key');
    const init = fetch.mock.calls[0][1];
    expect(init.headers.get('X-Goog-Api-Key')).toBe('private-key');
    expect(init.headers.get('X-Project')).toBe('custom');
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
  });
  it('parses actual HTTP OCR/formula contracts and bounded audio', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"text":"OCR result"}'))
      .mockResolvedValueOnce(new Response('{"latex":"x^2"}'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([82, 73, 70, 70]), {
          headers: { 'Content-Type': 'audio/wav' },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect((await remoteText(config(), 'ocr', 'data:image/png;base64,a', '', signal)).text).toBe(
      'OCR result',
    );
    expect(
      (await remoteText(config(), 'formula', 'data:image/png;base64,a', '', signal)).text,
    ).toBe('x^2');
    expect((await remoteSpeech(config('llm'), 'hello', signal)).size).toBe(4);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({
      input: 'hello',
      voice: 'alloy',
      response_format: 'wav',
    });
  });
  it('connection check sends no selection/body and treats auth errors separately from reachability', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const c = config('web', { key: 'secret' });
    expect(await checkProviderConnection(c, 'ocr', new AbortController().signal)).toEqual({
      status: 405,
    });
    expect(fetch.mock.calls[0][1].method).toBe('HEAD');
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    await expect(checkProviderConnection(c, 'ocr', new AbortController().signal)).rejects.toThrow(
      'HTTP 401',
    );
  });
  it('handles SSE split UTF-8/CRLF frames and signals partial progress', async () => {
    const source =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(source);
    let offset = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (offset >= bytes.length) c.close();
        else {
          c.enqueue(bytes.slice(offset, offset + 3));
          offset += 3;
        }
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        ),
    );
    const partial = vi.fn(),
      r = await remoteText(
        config('llm', { stream: true }),
        'translation',
        'hello',
        'zh',
        new AbortController().signal,
        partial,
      );
    expect(r.text).toBe('你好 world');
    expect(partial).toHaveBeenLastCalledWith('你好 world');
  });
  it('rejects disconnected SSE and does not expose remote errors or secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    await expect(
      remoteText(
        config('llm', { stream: true }),
        'translation',
        'hello',
        'zh',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Incomplete stream');
    expect(providerError(new Error('https://url?key=secret echoed response'))).not.toContain(
      'secret',
    );
  });
  it('cancels readers, rejects invalid input before network, and bounds outputs', async () => {
    const controller = new AbortController();
    let canceled = false;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n'));
        controller.abort();
      },
      cancel() {
        canceled = true;
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      remoteText(config('llm', { stream: true }), 'translation', 'hello', 'zh', controller.signal),
    ).rejects.toThrow();
    expect(canceled).toBe(true);
    const count = fetch.mock.calls.length;
    await expect(
      remoteText(config('llm', { model: '' }), 'ocr', 'image', '', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderInputError);
    expect(fetch.mock.calls).toHaveLength(count);
    fetch.mockResolvedValue(new Response(JSON.stringify({ text: 'x'.repeat(100001) })));
    await expect(
      remoteText(config(), 'ocr', 'image', '', new AbortController().signal),
    ).rejects.toThrow('Invalid text response');
  });
});
