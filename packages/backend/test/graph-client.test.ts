import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filterHumanParticipants, GraphClient, GraphError } from '../src/graph/client.js';
import { JOIN_URL, json, mockFetch, participant, tokenRoute, fetchCalls } from './helpers.js';

function client(overrides: Partial<ConstructorParameters<typeof GraphClient>[0]> = {}): GraphClient {
  return new GraphClient({
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecretProvider: async () => 'secret',
    sleep: async () => undefined,
    joinPollIntervalMs: 0,
    joinTimeoutMs: 1000,
    ...overrides,
  });
}

describe('GraphClient', () => {
  beforeEach(() => {
    vi.stubEnv('LOG_LEVEL', 'error');
  });

  it('caches the token across requests and refreshes when close to expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
    const fetch = mockFetch([
      { method: 'POST', match: /token/, reply: (_u, _i, n) => json(200, { access_token: `tok-${n}`, expires_in: 600 }) },
      { method: 'GET', match: /communications\/calls\/c1$/, reply: () => json(200, { id: 'c1', state: 'established' }) },
    ]);
    const c = client();
    await c.getCall('c1');
    await c.getCall('c1');
    expect(fetchCalls(fetch).filter((x) => x.url.includes('token'))).toHaveLength(1);
    // 600s expiry minus 5 min safety: after 6 minutes a new token is requested.
    vi.setSystemTime(new Date('2026-09-24T10:06:00Z'));
    await c.getCall('c1');
    expect(fetchCalls(fetch).filter((x) => x.url.includes('token'))).toHaveLength(2);
    const last = fetch.mock.calls.at(-1)![1] as RequestInit;
    expect((last.headers as Record<string, string>)['authorization']).toBe('Bearer tok-1');
    vi.useRealTimers();
  });

  it('sends client credentials with the .default scope', async () => {
    const fetch = mockFetch([tokenRoute, { method: 'GET', match: /calls\/c1$/, reply: () => json(200, { id: 'c1' }) }]);
    await client().getCall('c1');
    const tokenCall = fetch.mock.calls[0]![1] as RequestInit;
    const body = new URLSearchParams(String(tokenCall.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(body.get('client_secret')).toBe('secret');
  });

  it('retries on 429 honouring retry-after and then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = mockFetch([
      tokenRoute,
      { method: 'GET', match: /calls\/c1$/, reply: (_u, _i, n) => (n === 0 ? json(429, {}, { 'retry-after': '3' }) : n === 1 ? json(503, {}) : json(200, { id: 'c1', state: 'established' })) },
    ]);
    const call = await client({ sleep }).getCall('c1');
    expect(call?.id).toBe('c1');
    expect(fetchCalls(fetch).filter((x) => x.url.endsWith('/calls/c1'))).toHaveLength(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
  });

  it('gives up after three attempts and does not retry other 4xx', async () => {
    mockFetch([tokenRoute, { method: 'GET', match: /calls\/c1$/, reply: () => json(500, { error: { code: 'boom', message: 'x' } }) }, { method: 'GET', match: /calls\/c2$/, reply: () => json(403, { error: { code: 'Forbidden', message: 'no' } }) }]);
    const c = client();
    await expect(c.getCall('c1')).rejects.toMatchObject({ status: 500, code: 'boom' });
    await expect(c.getCall('c2')).rejects.toMatchObject({ status: 403, code: 'Forbidden' });
  });

  it('returns null on 404 for getCall and treats 404 on leaveCall as success', async () => {
    mockFetch([tokenRoute, { match: /calls\/gone$/, reply: () => json(404, { error: { code: 'ItemNotFound' } }) }]);
    const c = client();
    expect(await c.getCall('gone')).toBeNull();
    await expect(c.leaveCall('gone')).resolves.toBeUndefined();
  });

  it('joins a meeting with the expected payload and polls until established', async () => {
    const fetch = mockFetch([
      tokenRoute,
      { method: 'POST', match: /communications\/calls$/, reply: () => json(201, { id: 'call-1', state: 'establishing' }) },
      { method: 'GET', match: /calls\/call-1$/, reply: (_u, _i, n) => json(200, { id: 'call-1', state: n < 2 ? 'establishing' : 'established', myParticipantId: 'bot-p' }) },
    ]);
    const result = await client().joinMeeting(JOIN_URL, 'https://cb/graph/callback?incident_id=x');
    expect(result).toEqual({ callId: 'call-1', botParticipantId: 'bot-p' });
    const post = fetchCalls(fetch).find((c) => c.method === 'POST' && c.url.endsWith('/communications/calls'))!;
    expect(post.body).toMatchObject({
      '@odata.type': '#microsoft.graph.call',
      callbackUri: 'https://cb/graph/callback?incident_id=x',
      requestedModalities: ['audio'],
      chatInfo: { threadId: '19:meeting_ABC123@thread.v2', messageId: '0' },
      meetingInfo: { organizer: { user: { id: 'organizer-1', tenantId: 'tenant-1' } } },
      tenantId: 'tenant-1',
    });
    expect(fetchCalls(fetch).filter((c) => c.method === 'GET')).toHaveLength(3);
  });

  it('fails joinMeeting when the call terminates or times out', async () => {
    mockFetch([tokenRoute, { method: 'POST', match: /communications\/calls$/, reply: () => json(201, { id: 'c', state: 'terminated' }) }]);
    await expect(client().joinMeeting(JOIN_URL, 'cb')).rejects.toBeInstanceOf(GraphError);
    mockFetch([tokenRoute, { method: 'POST', match: /communications\/calls$/, reply: () => json(201, { id: 'c', state: 'establishing' }) }, { method: 'GET', match: /calls\/c$/, reply: () => json(200, { id: 'c', state: 'establishing' }) }]);
    await expect(client({ joinTimeoutMs: -1 }).joinMeeting(JOIN_URL, 'cb')).rejects.toMatchObject({ code: 'joinTimeout' });
  });

  it('invites a participant with identity.user.id and a clientContext', async () => {
    const fetch = mockFetch([tokenRoute, { method: 'POST', match: /participants\/invite$/, reply: () => json(200, {}) }]);
    await client().inviteParticipant('c1', 'oid-9', 'Ana');
    const body = fetchCalls(fetch).at(-1)!.body as { participants: { identity: { user: { id: string } } }[]; clientContext: string };
    expect(body.participants[0]!.identity.user.id).toBe('oid-9');
    expect(body.clientContext).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('filters humans: excludes bot/app identities, the lobby and the bot participant id', () => {
    const raw = [
      participant('u1', 'Uno'),
      participant('u2', 'Dos', { isInLobby: true }),
      { id: 'bot-p', info: { identity: { application: { id: 'app' } } } },
      { id: 'x', info: { identity: { user: { id: 'u3' }, application: { id: 'app2' } } } },
      { id: 'bot-p', info: { identity: { user: { id: 'u4' } } } },
      { id: 'nouser', info: { identity: {} } },
    ];
    expect(filterHumanParticipants(raw, 'bot-p')).toEqual([{ id: 'u1', display_name: 'Uno' }]);
  });

  it('lists participants through the API and searches users with ConsistencyLevel', async () => {
    const fetch = mockFetch([
      tokenRoute,
      { method: 'GET', match: /calls\/c1\/participants$/, reply: () => json(200, { value: [participant('u1'), participant('u2', 'Dos', { isInLobby: true })] }) },
      { method: 'GET', match: /\/users\?/, reply: () => json(200, { value: [{ id: 'u1', displayName: 'Ana', userPrincipalName: 'ana@x' }] }) },
    ]);
    const c = client();
    expect(await c.listParticipants('c1')).toEqual([{ id: 'u1', display_name: 'Usuario u1' }]);
    expect(await c.searchUsers('an"a')).toEqual([{ id: 'u1', upn: 'ana@x', name: 'Ana' }]);
    const search = fetch.mock.calls.at(-1)!;
    expect(String(search[0])).toContain('%24search=');
    expect((search[1]!.headers as Record<string, string>)['ConsistencyLevel']).toBe('eventual');
  });
});
