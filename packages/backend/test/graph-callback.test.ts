import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/graph-callback.js';
import { setKeyResolverForTests } from '../src/graph/notifications.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { apiEvent, auditTypes, createFakeDynamo, GRAPH_CLIENT_ID, incident, mockFetch, mockSecrets, participant, seedIncident, setBaseEnv, TABLES, tokenRoute } from './helpers.js';

let privateKey: KeyLike;
let db: FakeDynamo;
const INC = '01J0000000000000000000INC1';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  setKeyResolverForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }));
});

async function token(overrides: { issuer?: string; audience?: string; expired?: boolean } = {}): Promise<string> {
  const jwt = new SignJWT({ serviceurl: 'https://graph.microsoft.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(overrides.issuer ?? 'https://api.botframework.com')
    .setAudience(overrides.audience ?? GRAPH_CLIENT_ID)
    .setIssuedAt();
  if (overrides.expired) jwt.setExpirationTime('-1h');
  else jwt.setExpirationTime('1h');
  return jwt.sign(privateKey);
}

function notification(body: unknown, auth: string | undefined, incidentId: string | undefined = INC) {
  return apiEvent({ path: '/graph/callback', headers: auth ? { authorization: auth } : {}, body, query: incidentId ? { incident_id: incidentId } : undefined });
}

function participantsBody(callId: string, participants: unknown[]) {
  return { value: [{ changeType: 'updated', resource: `/app/calls/${callId}/participants`, resourceUrl: `/communications/calls/${callId}/participants`, resourceData: participants }] };
}

beforeEach(() => {
  setBaseEnv();
  mockSecrets();
  mockFetch([tokenRoute]);
  db = createFakeDynamo();
});

afterEach(() => db.restore());

describe('graph-callback handler', () => {
  it('rejects missing, malformed, wrong-issuer, wrong-audience and expired tokens', async () => {
    expect((await handler(notification({}, undefined))).statusCode).toBe(401);
    expect((await handler(notification({}, 'Bearer nope'))).statusCode).toBe(401);
    expect((await handler(notification({}, `Bearer ${await token({ issuer: 'https://evil' })}`))).statusCode).toBe(401);
    expect((await handler(notification({}, `Bearer ${await token({ audience: 'other' })}`))).statusCode).toBe(401);
    expect((await handler(notification({}, `Bearer ${await token({ expired: true })}`))).statusCode).toBe(401);
    expect(db.items(TABLES.audit)).toHaveLength(0);
  });

  it('accepts a valid token even without incident_id or notifications', async () => {
    expect((await handler(notification({}, `Bearer ${await token()}`, undefined))).statusCode).toBe(202);
    expect((await handler(notification({ value: [] }, `Bearer ${await token()}`))).statusCode).toBe(202);
  });

  it('diffs the roster and audits member_joined / member_left', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1', bot_participant_id: 'bot-p', participants: [{ id: 'u1', display_name: 'Uno', joined_at: '2026-09-24T10:01:00.000Z' }], participant_count: 1, ever_connected: true }));
    const body = participantsBody('call-1', [participant('u2', 'Dos'), { id: 'bot-p', info: { identity: { application: { id: GRAPH_CLIENT_ID } } } }, participant('u3', 'Tres', { isInLobby: true })]);
    const res = await handler(notification(body, `Bearer ${await token()}`));
    expect(res.statusCode).toBe(202);
    const inc = db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${INC}`)!;
    expect(inc['participants']).toEqual([{ id: 'u2', display_name: 'Dos', joined_at: expect.any(String) }]);
    expect(inc['participant_count']).toBe(1);
    expect(inc['participants_updated_at']).toEqual(expect.any(String));
    expect(auditTypes(db, INC)).toEqual(['member_joined', 'member_left']);
    const events = db.items(TABLES.audit);
    expect(events.find((e) => e['event_type'] === 'member_joined')!['details']).toMatchObject({ member_id: 'u2' });
    expect(events.find((e) => e['event_type'] === 'member_left')!['details']).toMatchObject({ member_id: 'u1' });
  });

  it('marks ever_connected when the first human joins and ignores other calls', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1' }));
    await handler(notification(participantsBody('other-call', [participant('u9')]), `Bearer ${await token()}`));
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${INC}`)!['participant_count']).toBe(0);
    await handler(notification(participantsBody('call-1', [participant('u1')]), `Bearer ${await token()}`));
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${INC}`)).toMatchObject({ participant_count: 1, ever_connected: true });
  });

  it('closes the incident when the call terminates after someone connected', async () => {
    seedIncident(db, incident({ status: 'connected', room_call_id: 'call-1', bot_participant_id: 'bot-p', ever_connected: true, participants: [{ id: 'u1', display_name: 'Uno', joined_at: 'x' }], participant_count: 1 }));
    const body = { value: [{ changeType: 'deleted', resource: '/app/calls/call-1', resourceData: { '@odata.type': '#microsoft.graph.call', state: 'terminated', resultInfo: { code: 0 } } }] };
    await handler(notification(body, `Bearer ${await token()}`));
    const inc = db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${INC}`)!;
    expect(inc).toMatchObject({ status: 'closed', close_reason: 'call_terminated' });
    expect(inc['room_call_id']).toBeUndefined();
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'LOCK#payments-api')).toBeUndefined();
    expect(auditTypes(db, INC)).toEqual(['incident_closed']);
  });

  it('only clears room_call_id when the call terminates before anyone connected', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1', bot_participant_id: 'bot-p' }));
    const body = { value: [{ changeType: 'updated', resource: '/communications/calls/call-1', resourceData: { state: 'terminated' } }] };
    await handler(notification(body, `Bearer ${await token()}`));
    const inc = db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${INC}`)!;
    expect(inc['status']).toBe('convoking');
    expect(inc['room_call_id']).toBeUndefined();
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'LOCK#payments-api')).toBeDefined();
  });
});
