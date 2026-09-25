import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/presence-monitor.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { auditTypes, createFakeDynamo, incident, json, mockFetch, mockSecrets, participant, seedIncident, setBaseEnv, TABLES, tokenRoute } from './helpers.js';

const sfn = mockClient(SFNClient);
const sns = mockClient(SNSClient);
let db: FakeDynamo;
const NOW = new Date('2026-09-24T12:00:00.000Z');

beforeEach(() => {
  setBaseEnv();
  mockSecrets();
  sfn.reset();
  sns.reset();
  sns.on(PublishCommand).resolves({});
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = createFakeDynamo();
});

afterEach(() => {
  vi.useRealTimers();
  db.restore();
});

const find = (id: string) => db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${id}`)!;
const lock = (system: string) => db.items(TABLES.incidents).find((i) => i['pk'] === `LOCK#${system}`);

describe('presence-monitor handler', () => {
  it('closes connected incidents whose room is empty, leaves the call and removes the lock', async () => {
    seedIncident(db, incident({ incident_id: 'A', status: 'connected', room_call_id: 'call-a', bot_participant_id: 'bot', ever_connected: true, participants: [{ id: 'u1', display_name: 'Uno', joined_at: 'x' }], participant_count: 1 }));
    seedIncident(db, incident({ incident_id: 'B', system_id: 'orders-api', status: 'connected', room_call_id: 'call-b', ever_connected: true, participants: [{ id: 'u2', display_name: 'Dos', joined_at: 'x' }], participant_count: 1 }));
    const fetch = mockFetch([
      tokenRoute,
      { method: 'GET', match: /calls\/call-a\/participants$/, reply: () => json(200, { value: [] }) },
      { method: 'GET', match: /calls\/call-b\/participants$/, reply: () => json(200, { value: [participant('u2', 'Dos')] }) },
      { method: 'DELETE', match: /calls\/call-a$/, reply: () => json(204, undefined) },
    ]);
    const summary = await handler();
    expect(summary).toMatchObject({ checked: 2, closed: ['A'], errors: [] });
    expect(find('A')).toMatchObject({ status: 'closed', close_reason: 'room_empty', participant_count: 0 });
    expect(find('A')['room_call_id']).toBeUndefined();
    expect(lock('payments-api')).toBeUndefined();
    expect(auditTypes(db, 'A')).toEqual(['member_left', 'incident_closed']);
    expect(find('B')).toMatchObject({ status: 'connected', participant_count: 1 });
    expect(lock('orders-api')).toBeDefined();
    expect(fetch.mock.calls.filter(([, i]) => i?.method === 'DELETE')).toHaveLength(1);
  });

  it('does not close a convoking incident that never connected, but closes orphans whose execution ended', async () => {
    seedIncident(db, incident({ incident_id: 'C', status: 'convoking', room_call_id: 'call-c', execution_arn: 'arn:exec:c' }));
    seedIncident(db, incident({ incident_id: 'D', system_id: 'orders-api', status: 'convoking', execution_arn: 'arn:exec:d' }));
    sfn.on(DescribeExecutionCommand, { executionArn: 'arn:exec:c' }).resolves({ status: 'RUNNING', executionArn: 'arn:exec:c', stateMachineArn: 'x', startDate: NOW });
    sfn.on(DescribeExecutionCommand, { executionArn: 'arn:exec:d' }).resolves({ status: 'FAILED', executionArn: 'arn:exec:d', stateMachineArn: 'x', startDate: NOW });
    mockFetch([tokenRoute, { method: 'GET', match: /calls\/call-c\/participants$/, reply: () => json(200, { value: [] }) }]);
    const summary = await handler();
    expect(summary.closed).toEqual(['D']);
    expect(find('C')['status']).toBe('convoking');
    expect(find('D')).toMatchObject({ status: 'closed', close_reason: 'execution_ended' });
    expect(lock('orders-api')).toBeUndefined();
    expect(sns.commandCalls(PublishCommand)).toHaveLength(1);
  });

  it('treats a vanished call (404) as an empty room', async () => {
    seedIncident(db, incident({ incident_id: 'E', status: 'connected', room_call_id: 'call-e', ever_connected: true, participants: [{ id: 'u1', display_name: 'Uno', joined_at: 'x' }], participant_count: 1 }));
    mockFetch([tokenRoute, { match: /calls\/call-e/, reply: () => json(404, { error: { code: 'ItemNotFound' } }) }]);
    const summary = await handler();
    expect(summary.closed).toEqual(['E']);
    expect(find('E')).toMatchObject({ status: 'closed', close_reason: 'room_empty' });
  });

  it('expires unanswered incidents after UNANSWERED_TTL_MINUTES', async () => {
    vi.stubEnv('UNANSWERED_TTL_MINUTES', '30');
    seedIncident(db, incident({ incident_id: 'F', status: 'unanswered', last_alert_at: '2026-09-24T11:00:00.000Z', room_call_id: 'call-f' }));
    seedIncident(db, incident({ incident_id: 'G', system_id: 'orders-api', status: 'unanswered', last_alert_at: '2026-09-24T11:45:00.000Z' }));
    mockFetch([tokenRoute, { method: 'DELETE', match: /calls\/call-f$/, reply: () => json(204, undefined) }]);
    const summary = await handler();
    expect(summary.closed).toEqual(['F']);
    expect(find('F')).toMatchObject({ status: 'closed', close_reason: 'unanswered_ttl' });
    expect(lock('payments-api')).toBeUndefined();
    expect(find('G')['status']).toBe('unanswered');
  });

  it('reports Graph errors without aborting the whole run', async () => {
    seedIncident(db, incident({ incident_id: 'H', status: 'connected', room_call_id: 'call-h', ever_connected: true, participant_count: 1 }));
    seedIncident(db, incident({ incident_id: 'I', system_id: 'orders-api', status: 'connected', room_call_id: 'call-i', ever_connected: true, participant_count: 0 }));
    mockFetch([tokenRoute, { match: /calls\/call-h\/participants$/, reply: () => json(403, {}) }, { match: /calls\/call-i\/participants$/, reply: () => json(200, { value: [] }) }, { method: 'DELETE', match: /calls\/call-i$/, reply: () => json(204, undefined) }]);
    const summary = await handler();
    expect(summary.errors).toEqual(['H']);
    expect(summary.closed).toEqual(['I']);
    expect(auditTypes(db, 'H')).toEqual(['graph_error']);
  });
});
