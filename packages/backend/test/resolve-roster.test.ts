import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handler, NoEligibleMembers } from '../src/handlers/resolve-roster.js';
import type { StateMachineInput } from '../src/domain/types.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { auditTypes, createFakeDynamo, incident, JOIN_URL, rosterItem, rule, seedIncident, setBaseEnv, TABLES } from './helpers.js';

let db: FakeDynamo;
const input: StateMachineInput = { incident_id: '01J0000000000000000000INC1', system_id: 'payments-api', severity: 'high', team_id: 'N2', escalation_count: 0, policy: { max_attempts: 5, ring_timeout_seconds: 45, max_escalations: 1 } };

beforeEach(() => {
  setBaseEnv();
  db = createFakeDynamo();
  db.seed(TABLES.severity, [rule({ severity: 'high', team_id: 'N2', escalate_to_team_id: 'N3', escalate_after_minutes: 10, notify_webhook_urls: ['https://hook.example.com/a'] })]);
  db.seed(TABLES.roster, [
    rosterItem({ team_id: 'N2', member_id: 'm1', priority_order: 1 }),
    rosterItem({ team_id: 'N2', member_id: 'm2', priority_order: 2 }),
    rosterItem({ team_id: 'N2', member_id: 'm3', priority_order: 3 }),
    rosterItem({ team_id: 'N3', member_id: 'x1', priority_order: 1 }),
  ]);
  db.seed(TABLES.availability, [
    { member_id: 'm2', valid_from: '2000-01-01T00:00:00Z', valid_until: '2100-01-01T00:00:00Z', status: 'vacation', backup_id: 'b2', backup_upn: 'b2@x', backup_name: 'Backup Dos', updated_at: 'x', updated_by: 'x' },
    { member_id: 'm3', valid_from: '2000-01-01T00:00:00Z', valid_until: '2100-01-01T00:00:00Z', status: 'unavailable', backup_id: 'b3', backup_upn: 'b3@x', updated_at: 'x', updated_by: 'x' },
    { member_id: 'b3', valid_from: '2000-01-01T00:00:00Z', valid_until: '2100-01-01T00:00:00Z', status: 'vacation', updated_at: 'x', updated_by: 'x' },
  ]);
  seedIncident(db, incident({ severity: 'high', team_id: 'N2', initial_team_id: 'N2', room_join_url: '' }));
});

afterEach(() => db.restore());

describe('resolve-roster handler', () => {
  it('resolves targets with substitution and cascade, and audits decisions', async () => {
    const out = await handler(input);
    expect(out).toMatchObject({ incident_id: input.incident_id, system_id: 'payments-api', severity: 'high', team_id: 'N2', room_join_url: JOIN_URL, escalate_to_team_id: 'N3', escalate_after_minutes: 10, notify_webhook_urls: ['https://hook.example.com/a'] });
    expect(out.cycle_started_at).toMatch(/Z$/);
    expect(out.targets).toEqual([
      { slot: 1, member: { id: 'm1', upn: 'm1@example.com', name: 'Persona m1' }, backup: null, substituted: false },
      { slot: 2, member: { id: 'b2', upn: 'b2@x', name: 'Backup Dos' }, backup: null, substituted: true },
    ]);
    expect(auditTypes(db, input.incident_id)).toEqual(['backup_substituted', 'member_skipped_unavailable', 'roster_resolved']);
    expect(db.items(TABLES.incidents).find((i) => i['pk'] === `INC#${input.incident_id}`)).toMatchObject({ team_id: 'N2', room_join_url: JOIN_URL });
  });

  it('uses the escalated team on the second cycle and does not escalate to itself', async () => {
    const out = await handler({ ...input, team_id: 'N3', escalation_count: 1 });
    expect(out.targets.map((t) => t.member.id)).toEqual(['x1']);
    expect(out.escalate_to_team_id).toBeNull();
    expect(out.escalate_after_minutes).toBe(10);
  });

  it('throws NoEligibleMembers when every slot is unavailable', async () => {
    db.seed(TABLES.availability, [{ member_id: 'm1', valid_from: '2000-01-01T00:00:00Z', valid_until: '2100-01-01T00:00:00Z', status: 'unavailable', updated_at: 'x', updated_by: 'x' }]);
    db.seed(TABLES.availability, [{ member_id: 'b2', valid_from: '2000-01-01T00:00:00Z', valid_until: '2100-01-01T00:00:00Z', status: 'unavailable', updated_at: 'x', updated_by: 'x' }]);
    const err = await handler(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoEligibleMembers);
    expect((err as Error).name).toBe('NoEligibleMembers');
    expect(auditTypes(db, input.incident_id)).toContain('roster_resolved');
  });

  it('throws NoEligibleMembers for a team without roster', async () => {
    await expect(handler({ ...input, system_id: 'unknown-system' })).rejects.toThrow(NoEligibleMembers);
  });
});
