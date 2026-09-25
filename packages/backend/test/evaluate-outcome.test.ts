import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/evaluate-outcome.js';
import type { EvaluateOutcomeInput } from '../src/domain/types.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { auditTypes, createFakeDynamo, fetchCalls, incident, json, mockFetch, rule, seedIncident, setBaseEnv, TABLES } from './helpers.js';

const sns = mockClient(SNSClient);
let db: FakeDynamo;
const INC = '01J0000000000000000000INC1';
const m = { id: 'u1', upn: 'u1@x', name: 'Uno' };
const base: EvaluateOutcomeInput = {
  incident_id: INC,
  system_id: 'payments-api',
  severity: 'high',
  team_id: 'N2',
  escalation_count: 0,
  policy: { max_attempts: 5, ring_timeout_seconds: 45, max_escalations: 1 },
  slot_results: [],
  escalate_to_team_id: 'N3',
  notify_webhook_urls: ['https://hook.example.com/a'],
  failure: null,
};

beforeEach(() => {
  setBaseEnv();
  sns.reset();
  sns.on(PublishCommand).resolves({ MessageId: 'x' });
  db = createFakeDynamo();
  seedIncident(db, incident({ severity: 'high', team_id: 'N2', initial_team_id: 'N2', monitor_name: 'Mon', condition_name: 'Cond' }));
});

afterEach(() => db.restore());

const inc = () => db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${INC}`)!;

describe('evaluate-outcome handler', () => {
  it('marks connected when a slot joined, audits exhausted slots and sends the card once', async () => {
    const fetch = mockFetch([{ method: 'POST', match: 'hook.example.com', reply: () => json(200, {}) }]);
    const out = await handler({ ...base, slot_results: [{ slot: 1, member: m, outcome: 'joined' }, { slot: 2, member: { ...m, id: 'u2' }, outcome: 'exhausted', attempt: 5 }] });
    expect(out).toEqual({ outcome: 'connected', escalation_count: 0 });
    expect(inc()).toMatchObject({ status: 'connected', ever_connected: true, notification_sent_at: expect.any(String) });
    expect(auditTypes(db, INC)).toEqual(['slot_exhausted', 'convocation_connected', 'notification_sent']);
    const card = fetchCalls(fetch)[0]!.body as { type: string; attachments: { content: { body: { text?: string }[] } }[] };
    expect(card.type).toBe('message');
    expect(card.attachments[0]!.content.body[0]!.text).toContain('payments-api');
    expect(sns.calls()).toHaveLength(0);

    // Second evaluation (e.g. after escalation) must not re-send the card.
    await handler({ ...base, slot_results: [{ slot: 1, member: m, outcome: 'joined' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('escalates when nobody joined and budget remains', async () => {
    mockFetch([{ method: 'POST', match: 'hook.example.com', reply: () => json(200, {}) }]);
    const out = await handler({ ...base, slot_results: [{ slot: 1, member: m, outcome: 'timed_out' }] });
    expect(out).toEqual({ outcome: 'escalate', next_team_id: 'N3', escalation_count: 1 });
    expect(inc()).toMatchObject({ status: 'convoking', team_id: 'N3', escalation_count: 1 });
    expect(auditTypes(db, INC)).toEqual(['slot_exhausted', 'team_escalated', 'notification_sent']);
  });

  it('ends unanswered, publishes to SNS and keeps the lock for the presence monitor', async () => {
    mockFetch([]);
    const out = await handler({ ...base, escalation_count: 1, team_id: 'N3', escalate_to_team_id: null, notify_webhook_urls: [], slot_results: [{ slot: 1, member: m, outcome: 'exhausted' }] });
    expect(out).toEqual({ outcome: 'unanswered', escalation_count: 1 });
    expect(inc()).toMatchObject({ status: 'unanswered' });
    expect(auditTypes(db, INC)).toEqual(['slot_exhausted', 'convocation_unanswered']);
    const publish = sns.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(publish.TopicArn).toBe(process.env['ALERTS_TOPIC_ARN']);
    expect(publish.Message).toContain('payments-api');
    expect(publish.Message).toContain('N2 -> N3');
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'LOCK#payments-api')).toBeDefined();
  });

  it('reloads the rule when the machine skipped ResolveRoster (no eligible members)', async () => {
    db.seed(TABLES.severity, [rule({ severity: 'high', team_id: 'N2', escalate_to_team_id: 'N3', notify_webhook_urls: [] })]);
    mockFetch([]);
    const out = await handler({ ...base, escalate_to_team_id: null, notify_webhook_urls: null, failure: 'no_eligible_members', slot_results: [] });
    expect(out).toEqual({ outcome: 'escalate', next_team_id: 'N3', escalation_count: 1 });
  });

  it('forces unanswered when the room could not be joined', async () => {
    mockFetch([{ method: 'POST', match: 'hook.example.com', reply: () => json(200, {}) }]);
    const out = await handler({ ...base, failure: 'room_join_failed', slot_results: [] });
    expect(out.outcome).toBe('unanswered');
    expect(sns.calls()).toHaveLength(1);
  });
});
