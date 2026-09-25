import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/check-joined.js';
import type { CheckJoinedInput } from '../src/domain/types.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { auditTypes, createFakeDynamo, incident, json, mockFetch, mockSecrets, participant, seedIncident, setBaseEnv, TABLES, tokenRoute } from './helpers.js';

let db: FakeDynamo;
const NOW = new Date('2026-09-24T10:12:00.000Z');
const input: CheckJoinedInput = { incident_id: '01J0000000000000000000INC1', room_call_id: 'call-1', member: { id: 'u1', upn: 'u1@x', name: 'Uno' }, slot: 1, attempt: 2, cycle_started_at: '2026-09-24T10:00:00.000Z', escalate_after_minutes: 10 };

beforeEach(() => {
  setBaseEnv();
  mockSecrets();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = createFakeDynamo();
});

afterEach(() => {
  vi.useRealTimers();
  db.restore();
});

describe('check-joined handler', () => {
  it('answers from the fresh incident roster without calling Graph', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1', participants: [{ id: 'u1', display_name: 'Uno', joined_at: 'x' }], participant_count: 1, participants_updated_at: '2026-09-24T10:11:50.000Z' }));
    const fetch = mockFetch([tokenRoute]);
    expect(await handler(input)).toEqual({ joined: true, elapsed_minutes: 12, time_exceeded: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes from Graph when the roster is stale and audits the diff', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1', bot_participant_id: 'bot-p', participants_updated_at: '2026-09-24T10:11:00.000Z' }));
    mockFetch([tokenRoute, { method: 'GET', match: /calls\/call-1\/participants$/, reply: () => json(200, { value: [participant('u1', 'Uno'), { id: 'bot-p', info: { identity: { application: { id: 'app' } } } }] }) }]);
    expect(await handler({ ...input, escalate_after_minutes: null })).toEqual({ joined: true, elapsed_minutes: 12, time_exceeded: false });
    expect(auditTypes(db, input.incident_id)).toEqual(['member_joined']);
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${input.incident_id}`)).toMatchObject({ participant_count: 1, ever_connected: true, participants_updated_at: NOW.toISOString() });
  });

  it('returns joined=false and time_exceeded=false before the escalation limit', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1' }));
    mockFetch([tokenRoute, { method: 'GET', match: /participants$/, reply: () => json(200, { value: [] }) }]);
    expect(await handler({ ...input, escalate_after_minutes: 30 })).toEqual({ joined: false, elapsed_minutes: 12, time_exceeded: false });
  });

  it('tolerates Graph failures (audits graph_error) and still returns a decision', async () => {
    seedIncident(db, incident({ room_call_id: 'call-1' }));
    mockFetch([tokenRoute, { method: 'GET', match: /participants$/, reply: () => json(403, { error: { code: 'Forbidden' } }) }]);
    expect(await handler(input)).toMatchObject({ joined: false, time_exceeded: true });
    expect(auditTypes(db, input.incident_id)).toEqual(['graph_error']);
  });
});
