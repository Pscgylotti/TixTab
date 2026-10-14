import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const {
  createChatGPT,
  createCredentialStore,
  validateInput,
  verifyIdentity,
} = require('../electron/chatgpt.cjs');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
function jwt(claims: any, header: any = { alg: 'RS256', kid: 'test-key' }) {
  const content = [header, claims]
    .map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'))
    .join('.');
  return content + '.' + sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
}
const identity = (nonce: string, overrides = {}) => ({
  iss: 'https://auth.openai.com',
  aud: 'oaiapp_test',
  sub: 'subject-1',
  email: 'test@example.com',
  nonce,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});
function harness(
  options: {
    scope?: string;
    expired?: boolean;
    stream?: string;
    contentType?: string;
    renewScope?: string;
    signOverrides?: any;
  } = {},
) {
  let data: any = {
    version: 1,
    host: 'urn:uuid:12345678-1234-1234-1234-123456789012',
    active: '',
    welcome: false,
    accounts: [],
  };
  let opened: URL;
  let notify: (url: URL) => void;
  const openedPromise = new Promise<URL>((resolve) => (notify = resolve)),
    calls: { url: string; options: any }[] = [];
  let refreshes = 0;
  const store = {
    status: () => 'encrypted',
    read: async () => structuredClone(data),
    write: async (next: any) => {
      data = structuredClone(next);
    },
  };
  const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, options: init });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/openid-configuration'))
      return Response.json({ revocation_endpoint: 'https://auth.openai.com/revoke' });
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    if (url.endsWith('/oauth/token')) {
      const refresh = new URLSearchParams(init.body).get('grant_type') === 'refresh_token';
      if (refresh) refreshes++;
      return Response.json({
        access_token: refresh ? 'rotated-access' : 'fixture-access',
        refresh_token: refresh ? 'rotated-refresh' : 'fixture-refresh',
        id_token: jwt(identity(opened.searchParams.get('nonce')!, options.signOverrides)),
        token_type: 'Bearer',
        expires_in: !refresh && options.expired ? 1 : 3600,
        scope: refresh
          ? options.renewScope || options.scope || 'chatgpt.tokens.use.direct'
          : options.scope || 'openid profile chatgpt.tokens.use.direct',
      });
    }
    if (url.endsWith('/models'))
      return Response.json({
        models: [
          { slug: 'hidden', display_name: 'hidden', visibility: 'hidden' },
          { slug: 'account-model', display_name: 'Account model', visibility: 'list' },
        ],
      });
    if (url.endsWith('/responses'))
      return new Response(
        new TextEncoder().encode(
          options.stream ??
            'data: {"type":"response.output_text.delta","delta":"First "}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"answer"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
        ),
        {
          headers: {
            ...(options.contentType === undefined
              ? { 'content-type': 'text/event-stream' }
              : options.contentType
                ? { 'content-type': options.contentType }
                : {}),
          },
        },
      );
    throw new Error('unexpected test URL');
  });
  const shell = {
    openExternal: vi.fn(async (raw: string) => {
      opened = new URL(raw);
      notify(opened);
    }),
  };
  const service = createChatGPT({ fetch: fetchMock, shell, store, loginTimeout: 5000 }),
    owner = { id: 1 };
  const startLogin = () => {
    const promise = service.run(owner, { action: 'login' });
    return { promise, opened: openedPromise };
  };
  const callback = async (url: URL, params: Record<string, string> = {}) => {
    const target = new URL(url.searchParams.get('redirect_uri')!);
    target.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      code: 'test-code',
      client_id: 'oaiapp_test',
      ...params,
    }).toString();
    return fetch(target);
  };
  const login = async () => {
    const next = startLogin(),
      url = await next.opened;
    await callback(url);
    return next.promise;
  };
  return {
    service,
    owner,
    store,
    shell,
    calls,
    startLogin,
    callback,
    login,
    getData: () => data,
    getRefreshes: () => refreshes,
  };
}
describe('ChatGPT official local-client integration', () => {
  it('streams a valid answer even when the server strips Content-Type', async () => {
    const h = harness({ contentType: '' });
    try {
      await h.login();
      const start = await h.service.run(h.owner, {
        action: 'start',
        model: 'account-model',
        messages: [{ role: 'user', text: 'Explain' }],
      });
      let result: any,
        text = '';
      do {
        result = await h.service.run(h.owner, { action: 'read', id: start.data.id });
        text += result.data.delta;
      } while (!result.data.done);
      expect(text).toBe('First answer');
      expect(result.data.error).toBe('');
      expect(result.data.diagnostic).toMatchObject({ mime: '', format: 'sse' });
    } finally {
      h.service.dispose();
    }
  });
  it.each([
    ['', 'empty-response'],
    ['{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}', 'limit'],
    ['<html>Unexpected upstream gateway response</html>', 'stream-format'],
  ])(
    'distinguishes headerless invalid bodies without claiming completion: %s',
    async (stream, error) => {
      const h = harness({ contentType: '', stream });
      try {
        await h.login();
        const start = await h.service.run(h.owner, {
          action: 'start',
          model: 'account-model',
          messages: [{ role: 'user', text: 'Explain' }],
        });
        let result: any;
        do {
          result = await h.service.run(h.owner, { action: 'read', id: start.data.id });
        } while (!result.data.done);
        expect(result.data.error).toBe(error);
        expect(result.data.delta).toBe('');
        expect(result.data.diagnostic.bytes).toBe(Buffer.byteLength(stream));
      } finally {
        h.service.dispose();
      }
    },
  );
  it('opens clicked web references externally and rejects executable or credential URLs', async () => {
    const h = harness();
    try {
      for (const url of [
        'file:///C:/private',
        'javascript:alert(1)',
        'https://user:pass@example.com',
        'invalid',
      ])
        expect(await h.service.run(h.owner, { action: 'open-link', url })).toEqual({
          ok: false,
          error: 'invalid',
        });
      expect(h.shell.openExternal).not.toHaveBeenCalled();
      expect(
        await h.service.run(h.owner, { action: 'open-link', url: 'https://example.com/paper' }),
      ).toEqual({ ok: true, data: true });
      expect(h.shell.openExternal).toHaveBeenCalledWith('https://example.com/paper');
    } finally {
      h.service.dispose();
    }
  });
  it('accepts an inline original PDF, rejects arbitrary file data and assistant uploads', () => {
    const file = {
      name: 'Original.pdf',
      data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.7\nfixture').toString('base64'),
    };
    const body = validateInput({
      model: 'm',
      messages: [{ role: 'user', text: 'Summarize', file }],
    });
    expect(body.input[0].content[1]).toEqual({
      type: 'input_file',
      filename: file.name,
      file_data: file.data,
    });
    for (const bad of [
      { ...file, name: '../private.pdf' },
      { ...file, data: 'https://example.com/x.pdf' },
      { ...file, data: 'data:application/pdf;base64,AAAA' },
    ])
      expect(() =>
        validateInput({ model: 'm', messages: [{ role: 'user', text: 'x', file: bad }] }),
      ).toThrow();
    expect(() =>
      validateInput({
        model: 'm',
        messages: [
          { role: 'assistant', text: 'x', file },
          { role: 'user', text: 'next' },
        ],
      }),
    ).toThrow();
  });
  it.each([
    [
      'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Final answer"}]}]}}\n\ndata: [DONE]\n\n',
      'Final answer',
    ],
    [
      'data: {"type":"response.output_text.done","text":"Final answer"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      'Final answer',
    ],
  ])('recovers final output when no text delta was emitted', async (stream, expected) => {
    const h = harness({ stream });
    try {
      await h.login();
      const start = await h.service.run(h.owner, {
        action: 'start',
        model: 'account-model',
        messages: [{ role: 'user', text: 'Explain' }],
      });
      let result: any,
        text = '';
      do {
        result = await h.service.run(h.owner, { action: 'read', id: start.data.id });
        text += result.data.delta;
      } while (!result.data.done);
      expect(text).toBe(expected);
      expect(result.data.error).toBe('');
    } finally {
      h.service.dispose();
    }
  });
  it('uses issued client, PKCE, stable loopback, signed nonce and no renderer credentials', async () => {
    const h = harness();
    try {
      const next = h.startLogin(),
        url = await next.opened;
      expect(url.origin).toBe('https://auth.openai.com');
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(url.searchParams.get('agent_name_hint')).toBe('TixTab');
      expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toHaveLength(43);
      expect(new URL(url.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
      expect((await h.callback(url, { state: 'wrong' })).status).toBe(400);
      expect(h.calls).toHaveLength(0);
      await h.callback(url);
      const result = await next.promise;
      expect(result.ok).toBe(true);
      expect(result.data.active).toBe('oaiapp_test');
      expect(result.data.welcome).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(
        /fixture-access|fixture-refresh|id_token|access_token/,
      );
      const body = new URLSearchParams(
        h.calls.find((c) => c.url.endsWith('/oauth/token'))!.options.body,
      );
      expect(body.get('client_id')).toBe('oaiapp_test');
      expect(body.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
      expect(body.get('code_verifier')).toHaveLength(43);
      expect(h.getData().host).toBe(url.searchParams.get('ext_agent_host_id'));
      await h.service.run(h.owner, { action: 'welcome' });
      expect((await h.service.run(h.owner, { action: 'status' })).data.welcome).toBe(false);
    } finally {
      h.service.dispose();
    }
  });
  it.each([
    { signOverrides: { nonce: 'wrong' }, error: 'identity' },
    { signOverrides: { sub: '', aud: 'attacker' }, error: 'identity' },
  ])('rejects incomplete authorization %#', async (options) => {
    const h = harness(options);
    try {
      expect(await h.login()).toEqual({ ok: false, error: options.error });
      expect(h.getData().accounts).toHaveLength(0);
    } finally {
      h.service.dispose();
    }
  });
  it('retains verified sign-in without inference permission and never calls Responses', async () => {
    const h = harness({ scope: 'openid email' });
    try {
      const login = await h.login();
      expect(login.ok).toBe(true);
      expect(login.data.accounts[0].enabled).toBe(false);
      expect(login.data.welcome).toBe(false);
      expect(
        await h.service.run(h.owner, {
          action: 'start',
          model: 'account-model',
          messages: [{ role: 'user', text: 'Explain' }],
        }),
      ).toEqual({ ok: false, error: 'permission' });
      expect(h.calls.some((c) => c.url.endsWith('/responses'))).toBe(false);
    } finally {
      h.service.dispose();
    }
  });
  it('cancels pending browser login, keeps the host, and leaves no credential record', async () => {
    const h = harness();
    try {
      const login = h.startLogin();
      await login.opened;
      h.service.cancel(h.owner);
      expect(await login.promise).toEqual({ ok: false, error: 'cancelled' });
      expect(h.getData().accounts).toHaveLength(0);
      expect(h.getData().host).toMatch(/^urn:uuid:/);
    } finally {
      h.service.dispose();
    }
  });
  it('rejects a forged JWT signature and an algorithm change', async () => {
    const valid = jwt(identity('nonce'));
    await expect(
      verifyIdentity(
        valid.slice(0, -8) + 'aaaaaaaa',
        { keys: [jwk] },
        { client: 'oaiapp_test', nonce: 'nonce' },
      ),
    ).rejects.toThrow('identity');
    await expect(
      verifyIdentity(
        jwt(identity('nonce'), { alg: 'none', kid: 'test-key' }),
        { keys: [jwk] },
        { client: 'oaiapp_test', nonce: 'nonce' },
      ),
    ).rejects.toThrow('identity');
  });
  it('refreshes rotating tokens once, lists account models and streams Responses with full history', async () => {
    const h = harness({ expired: true });
    try {
      await h.login();
      const [models, again] = await Promise.all([
        h.service.run(h.owner, { action: 'models' }),
        h.service.run(h.owner, { action: 'models' }),
      ]);
      expect(models.data).toEqual([{ id: 'account-model', name: 'Account model' }]);
      expect(again.ok).toBe(true);
      expect(h.getRefreshes()).toBe(1);
      const started = await h.service.run(h.owner, {
        action: 'start',
        model: 'account-model',
        messages: [
          { role: 'user', text: 'PDF page 1' },
          { role: 'assistant', text: 'Previous answer' },
          { role: 'user', text: 'Explain more' },
        ],
      });
      expect(started.ok).toBe(true);
      let text = '',
        end: any;
      do {
        end = await h.service.run(h.owner, { action: 'read', id: started.data.id });
        expect(end.ok).toBe(true);
        text += end.data.delta;
      } while (!end.data.done);
      expect(text).toBe('First answer');
      expect(end.data.error).toBe('');
      const call = h.calls.find((c) => c.url.endsWith('/responses'))!,
        body = JSON.parse(call.options.body);
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.input).toHaveLength(3);
      expect(body).not.toHaveProperty('previous_response_id');
      expect(call.options.headers.Authorization).toBe('Bearer rotated-access');
      const revoked = await h.service.run(h.owner, { action: 'logout', id: 'oaiapp_test' });
      expect(revoked.data.revoked).toBe(true);
      expect(h.getData().accounts[0].refresh).toBe('');
      expect(h.getData().accounts[0].id).toBe('oaiapp_test');
    } finally {
      h.service.dispose();
    }
  });
  it.each([
    [
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
      'limit',
    ],
    ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n', 'incomplete'],
    ['data: {"type":"response.incomplete"}\n\n', 'incomplete'],
  ])('retains partial output but requires explicit completion', async (stream, error) => {
    const h = harness({ stream });
    try {
      await h.login();
      const start = await h.service.run(h.owner, {
        action: 'start',
        model: 'account-model',
        messages: [{ role: 'user', text: 'Explain' }],
      });
      let last: any,
        text = '';
      do {
        last = await h.service.run(h.owner, { action: 'read', id: start.data.id });
        text += last.data.delta;
      } while (!last.data.done);
      expect(last.data.error).toBe(error);
      if (stream.includes('partial')) expect(text).toBe('partial');
    } finally {
      h.service.dispose();
    }
  });
  it('does not let another owner read or cancel the current stream', async () => {
    const h = harness();
    try {
      await h.login();
      const start = await h.service.run(h.owner, {
        action: 'start',
        model: 'account-model',
        messages: [{ role: 'user', text: 'Explain' }],
      });
      expect(await h.service.run({ id: 2 }, { action: 'read', id: start.data.id })).toEqual({
        ok: false,
        error: 'cancelled',
      });
      await h.service.run({ id: 2 }, { action: 'cancel' });
      expect((await h.service.run(h.owner, { action: 'read', id: start.data.id })).ok).toBe(true);
    } finally {
      h.service.dispose();
    }
  });
  it('rejects unsafe or oversized context before starting any network request', () => {
    expect(() =>
      validateInput({ model: 'x', messages: [{ role: 'system', text: 'bad' }] }),
    ).toThrow('invalid');
    expect(() =>
      validateInput({
        model: 'x',
        messages: [{ role: 'user', text: 'x', image: 'https://remote.example/a.png' }],
      }),
    ).toThrow('input-limit');
    expect(() =>
      validateInput({ model: 'x', messages: [{ role: 'user', text: 'a'.repeat(64001) }] }),
    ).toThrow();
    expect(
      validateInput({
        model: 'x',
        messages: [{ role: 'user', text: 'x', image: 'data:image/jpeg;base64,AA==' }],
      }).input[0].content[1].type,
    ).toBe('input_image');
  });
  it.each(['iss', 'aud', 'nonce', 'exp', 'sub'])(
    'rejects invalid signed identity claim %s',
    async (claim) => {
      const claims: any = identity('nonce');
      claims[claim] = claim === 'exp' ? 0 : 'wrong';
      await expect(
        verifyIdentity(
          jwt(claims),
          { keys: [jwk] },
          { client: 'oaiapp_test', nonce: 'nonce', subject: 'subject-1' },
        ),
      ).rejects.toThrow('identity');
    },
  );
  it('never overwrites unreadable encrypted credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'surfacetab-chat-test-')),
      file = join(dir, 'vault.enc');
    await writeFile(file, 'unreadable');
    const store = createCredentialStore({
      file,
      safeStorage: {
        isEncryptionAvailable: () => true,
        decryptString: () => {
          throw Error('bad');
        },
        encryptString: () => Buffer.from('replacement'),
      },
    });
    try {
      await expect(store.read()).rejects.toThrow('storage');
      await expect(store.write({})).rejects.toThrow('storage');
      expect(await readFile(file, 'utf8')).toBe('unreadable');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
