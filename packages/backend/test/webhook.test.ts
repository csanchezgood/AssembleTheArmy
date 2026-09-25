import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/webhook.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { apiEvent, auditTypes, createFakeDynamo, incident, json, mockFetch, mockSecrets, participant, rosterItem, rule, seedIncident, setBaseEnv, TABLES, tokenRoute, WEBHOOK_SECRET } from './helpers.js';

const sfn = mockClient(SFNClient);
let db: FakeDynamo;

const body = { system_tag: ' Payments-API ', severity: 'CRITICAL', monitor_name: 'Payments - error rate', condition_name: 'Error rate > 5%', current_state: 'open', timestamp: '2026-09-24T18:03:11Z' };

function event(overrides: { body?: unknown; secret?: string } = {}) {
  return apiEvent({ path: '/webhook/newrelic', headers: { 'X-Webhook-Secret': overrides.secret ?? WEBHOOK_SECRET }, body: overrides.body ?? body });
}

beforeEach(() => {
  setBaseEnv();
  mockSecrets();
  sfn.reset();
  sfn.on(StartExecutionCommand).resolves({ executionArn: 'arn:aws:states:us-east-1:000000000000:execution:sm:x', startDate: new Date() });
  db = createFakeDynamo();
  db.seed(TABLES.severity, [rule({ severity: 'critical', team_id: 'N3', escalate_to_team_id: undefined })]);
  db.seed(TABLES.roster, [rosterItem({ member_id: 'm1', priority_order: 1 }), rosterItem({ member_id: 'm2', priority_order: 2 })]);
  mockFetch([tokenRoute]);
});

afterEach(() => db.restore());

describe('webhook handler', () => {
  it('returns 401 without body on a wrong or missing secret', async () => {
    expect(await handler(event({ secret: 'nope' }))).toMatchObject({ statusCode: 401, body: '' });
    const noHeader = apiEvent({ path: '/webhook/newrelic', body });
    expect((await handler(noHeader)).statusCode).toBe(401);
    expect(db.items(TABLES.audit)).toHaveLength(0);
  });

  it('returns 400 on an invalid body', async () => {
    expect((await handler(event({ body: 'not json' }))).statusCode).toBe(400);
    expect((await handler(event({ body: { severity: 'critical' } }))).statusCode).toBe(400);
    expect(await handler(apiEvent({ path: '/webhook/newrelic', headers: { 'x-webhook-secret': WEBHOOK_SECRET } }))).toMatchObject({ statusCode: 400 });
  });

  it('ignores non-open alerts and audits them under SYSTEM#', async () => {
    const res = await handler(event({ body: { ...body, current_state: 'closed' } }));
    expect(JSON.parse(res.body!)).toEqual({ result: 'ignored', reason: 'state_not_open' });
    expect(auditTypes(db, 'SYSTEM#payments-api')).toEqual(['alert_received', 'alert_ignored']);
    expect(sfn.calls()).toHaveLength(0);
  });

  it('ignores unknown or disabled severities', async () => {
    expect(JSON.parse((await handler(event({ body: { ...body, severity: 'info' } }))).body!)).toEqual({ result: 'ignored', reason: 'no_severity_rule' });
    db.seed(TABLES.severity, [rule({ severity: 'warning', enabled: false })]);
    expect(JSON.parse((await handler(event({ body: { ...body, severity: 'warning' } }))).body!)).toEqual({ result: 'ignored', reason: 'severity_disabled' });
  });

  it('ignores with no_roster and emits the EMF metric', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    db.seed(TABLES.severity, [rule({ severity: 'high', team_id: 'N2' })]);
    const res = await handler(event({ body: { ...body, severity: 'high' } }));
    expect(JSON.parse(res.body!)).toEqual({ result: 'ignored', reason: 'no_roster' });
    const emf = write.mock.calls.map((c) => String(c[0])).find((l) => l.includes('AssembleTheArmy/ConfigErrors'));
    expect(emf).toBeDefined();
    expect(JSON.parse(emf!)).toMatchObject({ Reason: 'no_roster', ConfigErrors: 1, system_id: 'payments-api' });
  });

  it('opens an incident, creates the lock and starts the state machine', async () => {
    vi.stubEnv('MAX_ATTEMPTS', '3');
    vi.stubEnv('RING_TIMEOUT_SECONDS', '30');
    const res = await handler(event());
    const out = JSON.parse(res.body!) as { result: string; incident_id: string };
    expect(res.statusCode).toBe(200);
    expect(out.result).toBe('convoked');
    expect(out.incident_id).toMatch(/^[0-9A-Z]{26}$/);

    const inc = db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${out.incident_id}`)!;
    expect(inc).toMatchObject({ system_id: 'payments-api', severity: 'critical', team_id: 'N3', initial_team_id: 'N3', status: 'convoking', monitor_name: 'Payments - error rate', participants: [], echo_count: 0, escalation_count: 0, execution_arn: expect.stringContaining('execution') });
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'LOCK#payments-api')).toMatchObject({ incident_id: out.incident_id });
    expect(auditTypes(db, out.incident_id)).toEqual(['incident_opened']);

    const start = sfn.commandCalls(StartExecutionCommand)[0]!.args[0].input;
    expect(start.name).toBe(out.incident_id);
    expect(JSON.parse(start.input!)).toEqual({ incident_id: out.incident_id, system_id: 'payments-api', severity: 'critical', team_id: 'N3', escalation_count: 0, policy: { max_attempts: 3, ring_timeout_seconds: 30, max_escalations: 1 } });
  });

  it('treats a second alert while convoking as an echo', async () => {
    seedIncident(db, incident({ status: 'convoking' }));
    const res = await handler(event());
    expect(JSON.parse(res.body!)).toEqual({ result: 'echo', incident_id: '01J0000000000000000000INC1' });
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'INC#01J0000000000000000000INC1')).toMatchObject({ echo_count: 1 });
    expect(auditTypes(db, '01J0000000000000000000INC1')).toEqual(['alert_echo']);
    expect(sfn.calls()).toHaveLength(0);
  });

  it('echoes when connected and the room still has humans', async () => {
    seedIncident(db, incident({ status: 'connected', room_call_id: 'call-1', bot_participant_id: 'bot-p', ever_connected: true }));
    mockFetch([tokenRoute, { method: 'GET', match: /calls\/call-1\/participants$/, reply: () => json(200, { value: [participant('u1')] }) }]);
    expect(JSON.parse((await handler(event())).body!)).toMatchObject({ result: 'echo' });
    expect(sfn.calls()).toHaveLength(0);
  });

  it('closes an empty connected incident and convokes again', async () => {
    seedIncident(db, incident({ status: 'connected', room_call_id: 'call-1', bot_participant_id: 'bot-p', ever_connected: true }));
    const fetch = mockFetch([
      tokenRoute,
      { method: 'GET', match: /calls\/call-1\/participants$/, reply: () => json(200, { value: [] }) },
      { method: 'DELETE', match: /calls\/call-1$/, reply: () => json(204, undefined) },
    ]);
    const out = JSON.parse((await handler(event())).body!) as { result: string; incident_id: string };
    expect(out.result).toBe('convoked');
    expect(out.incident_id).not.toBe('01J0000000000000000000INC1');
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'INC#01J0000000000000000000INC1')).toMatchObject({ status: 'closed', close_reason: 'empty_on_new_alert' });
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'LOCK#payments-api')).toMatchObject({ incident_id: out.incident_id });
    expect(auditTypes(db, '01J0000000000000000000INC1')).toEqual(['incident_closed']);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(sfn.calls()).toHaveLength(1);
  });

  it('removes an orphan lock (closed/unanswered incident) and convokes', async () => {
    seedIncident(db, incident({ status: 'unanswered' }));
    const out = JSON.parse((await handler(event())).body!) as { result: string; incident_id: string };
    expect(out.result).toBe('convoked');
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === 'LOCK#payments-api')).toMatchObject({ incident_id: out.incident_id });
  });

  it('is idempotent when the state machine execution already exists', async () => {
    const err = new Error('exists');
    err.name = 'ExecutionAlreadyExists';
    sfn.on(StartExecutionCommand).rejects(err);
    expect(JSON.parse((await handler(event())).body!)).toMatchObject({ result: 'convoked' });
  });
});
