import { describe, expect, it } from 'vitest';
import { decideBeforeLock, decideOnLock, lockTtlFor } from '../src/domain/dedupe.js';
import type { LockItem, WebhookPayload } from '../src/domain/types.js';
import { incident, rule } from './helpers.js';

const payload: WebhookPayload = { system_tag: 'payments-api', severity: 'critical', current_state: 'open' };
const lock: LockItem = { system_id: 'payments-api', incident_id: 'inc-1', created_at: '2026-09-24T10:00:00Z', ttl: 0 };

describe('decideBeforeLock (steps 3-5)', () => {
  it('ignores alerts whose state is not open', () => {
    expect(decideBeforeLock({ ...payload, current_state: 'closed' }, rule(), 3)).toEqual({ kind: 'ignored', reason: 'state_not_open' });
    expect(decideBeforeLock({ ...payload, current_state: 'OPEN ' }, rule(), 3).kind).toBe('proceed');
  });
  it('ignores when there is no rule or it is disabled', () => {
    expect(decideBeforeLock(payload, undefined, 3)).toEqual({ kind: 'ignored', reason: 'no_severity_rule' });
    expect(decideBeforeLock(payload, rule({ enabled: false }), 3)).toEqual({ kind: 'ignored', reason: 'severity_disabled' });
  });
  it('ignores with no_roster when the team has no members', () => {
    expect(decideBeforeLock(payload, rule(), 0)).toEqual({ kind: 'ignored', reason: 'no_roster' });
  });
  it('proceeds otherwise', () => {
    const r = rule();
    expect(decideBeforeLock(payload, r, 2)).toEqual({ kind: 'proceed', rule: r });
  });
});

describe('decideOnLock (step 6)', () => {
  it('convokes when there is no lock', () => {
    expect(decideOnLock(undefined, undefined)).toEqual({ kind: 'convoke', stale_lock: false });
  });
  it('treats a lock without incident as stale', () => {
    expect(decideOnLock(lock, undefined)).toEqual({ kind: 'convoke', stale_lock: true });
  });
  it('echoes while convoking', () => {
    const inc = incident({ status: 'convoking' });
    expect(decideOnLock(lock, inc)).toEqual({ kind: 'echo', incident: inc });
  });
  it('asks for participants when connected, then echoes or closes', () => {
    const inc = incident({ status: 'connected' });
    expect(decideOnLock(lock, inc)).toEqual({ kind: 'check_participants', incident: inc });
    expect(decideOnLock(lock, inc, 2)).toEqual({ kind: 'echo', incident: inc });
    expect(decideOnLock(lock, inc, 0)).toEqual({ kind: 'close_and_convoke', incident: inc, close_reason: 'empty_on_new_alert' });
  });
  it('clears orphan locks for unanswered/closed incidents', () => {
    expect(decideOnLock(lock, incident({ status: 'unanswered' }))).toEqual({ kind: 'convoke', stale_lock: true });
    expect(decideOnLock(lock, incident({ status: 'closed' }))).toEqual({ kind: 'convoke', stale_lock: true });
  });
  it('lock ttl is 24h ahead', () => {
    const now = new Date('2026-09-24T10:00:00Z');
    expect(lockTtlFor(now)).toBe(Math.floor(now.getTime() / 1000) + 86400);
  });
});
