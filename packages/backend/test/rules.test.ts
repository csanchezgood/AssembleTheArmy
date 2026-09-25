import { describe, expect, it } from 'vitest';
import {
  backupAt,
  escalationTargetFor,
  isUnavailableAt,
  isWindowActive,
  normalizeSeverity,
  normalizeSystemId,
  parseJoinUrl,
  resolveTargets,
  resolveTeamForSeverity,
} from '../src/domain/rules.js';
import type { AvailabilityItem } from '../src/domain/types.js';
import { JOIN_URL, rosterItem, rule } from './helpers.js';

const T = '2026-09-24T12:00:00.000Z';

function avail(member: string, overrides: Partial<AvailabilityItem> = {}): AvailabilityItem {
  return {
    member_id: member,
    valid_from: '2026-09-20T00:00:00Z',
    valid_until: '2026-09-30T00:00:00Z',
    status: 'vacation',
    updated_at: T,
    updated_by: 'admin:x',
    ...overrides,
  };
}

describe('normalisation and severity resolution', () => {
  it('normalises system tag and severity', () => {
    expect(normalizeSystemId('  Payments-API ')).toBe('payments-api');
    expect(normalizeSeverity('CRITICAL')).toBe('critical');
  });

  it('resolves team from the rule, ignoring missing or disabled rules', () => {
    expect(resolveTeamForSeverity(undefined)).toEqual({ kind: 'ignored', reason: 'no_severity_rule' });
    expect(resolveTeamForSeverity(rule({ enabled: false }))).toEqual({ kind: 'ignored', reason: 'severity_disabled' });
    const r = rule({ team_id: 'N2' });
    expect(resolveTeamForSeverity(r)).toEqual({ kind: 'convoke', rule: r, team_id: 'N2' });
  });

  it('never escalates to the same team', () => {
    expect(escalationTargetFor(rule({ team_id: 'N2', escalate_to_team_id: 'N3' }), 'N2')).toBe('N3');
    expect(escalationTargetFor(rule({ team_id: 'N2', escalate_to_team_id: 'N3' }), 'N3')).toBeNull();
    expect(escalationTargetFor(rule(), 'N3')).toBeNull();
  });
});

describe('availability windows', () => {
  it('uses valid_from <= t < valid_until', () => {
    const r = avail('a', { valid_from: '2026-09-24T12:00:00Z', valid_until: '2026-09-24T13:00:00Z' });
    expect(isWindowActive(r, '2026-09-24T12:00:00Z')).toBe(true);
    expect(isWindowActive(r, '2026-09-24T12:59:59Z')).toBe(true);
    expect(isWindowActive(r, '2026-09-24T13:00:00Z')).toBe(false);
    expect(isWindowActive(r, '2026-09-24T11:59:59Z')).toBe(false);
  });

  it('ignores available records and invalid dates when deciding unavailability', () => {
    expect(isUnavailableAt([avail('a', { status: 'available' })], T)).toBe(false);
    expect(isUnavailableAt([avail('a', { valid_from: 'garbage' })], T)).toBe(false);
    expect(isUnavailableAt([avail('a', { status: 'unavailable' })], T)).toBe(true);
    expect(isUnavailableAt([avail('a', { valid_until: '2026-09-23T00:00:00Z' })], T)).toBe(false);
  });

  it('takes the backup from the unavailability record, or from a standing available record', () => {
    expect(backupAt([avail('a', { backup_id: 'b', backup_upn: 'b@x', backup_name: 'Beto' })], T)).toEqual({ id: 'b', upn: 'b@x', name: 'Beto' });
    expect(backupAt([avail('a', { status: 'available', backup_id: 'c', backup_upn: 'c@x' })], T)).toEqual({ id: 'c', upn: 'c@x', name: 'c@x' });
    expect(backupAt([avail('a')], T)).toBeNull();
    expect(backupAt([], T)).toBeNull();
  });
});

describe('resolveTargets (backup substitution and cascade)', () => {
  const roster = [
    rosterItem({ member_id: 'm1', priority_order: 1 }),
    rosterItem({ member_id: 'm2', priority_order: 2 }),
    rosterItem({ member_id: 'm3', priority_order: 3 }),
  ];

  it('keeps available members and their standing backup', () => {
    const availability = new Map([['m1', [avail('m1', { status: 'available', backup_id: 'b1', backup_upn: 'b1@x', backup_name: 'B1' })]]]);
    const res = resolveTargets(roster, availability, T);
    expect(res.targets.map((t) => [t.slot, t.member.id, t.backup?.id ?? null, t.substituted])).toEqual([
      [1, 'm1', 'b1', false],
      [2, 'm2', null, false],
      [3, 'm3', null, false],
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.substituted).toEqual([]);
  });

  it('calls the backup directly when the member is unavailable', () => {
    const availability = new Map([['m2', [avail('m2', { backup_id: 'b2', backup_upn: 'b2@x', backup_name: 'B2' })]]]);
    const res = resolveTargets(roster, availability, T);
    const slot2 = res.targets.find((t) => t.slot === 2);
    expect(slot2).toEqual({ slot: 2, member: { id: 'b2', upn: 'b2@x', name: 'B2' }, backup: null, substituted: true });
    expect(res.substituted).toHaveLength(1);
  });

  it('skips the slot (cascade) when member and backup are unavailable, and when there is no backup', () => {
    const availability = new Map([
      ['m1', [avail('m1', { backup_id: 'b1', backup_upn: 'b1@x' })]],
      ['b1', [avail('b1', { status: 'unavailable' })]],
      ['m3', [avail('m3')]],
    ]);
    const res = resolveTargets(roster, availability, T);
    expect(res.targets.map((t) => t.member.id)).toEqual(['m2']);
    expect(res.skipped.map((s) => [s.slot, s.reason])).toEqual([
      [1, 'member_and_backup_unavailable'],
      [3, 'member_unavailable_no_backup'],
    ]);
  });

  it('drops the standing backup when it is unavailable and de-duplicates members', () => {
    const availability = new Map([
      ['m1', [avail('m1', { status: 'available', backup_id: 'm2' })]],
      ['m2', [avail('m2', { status: 'unavailable', backup_id: 'm3', backup_upn: 'm3@x' })]],
    ]);
    const res = resolveTargets(roster, availability, T);
    expect(res.targets.map((t) => [t.member.id, t.backup, t.substituted])).toEqual([
      ['m1', null, false],
      ['m3', null, true],
    ]);
  });

  it('respects priority order regardless of input order', () => {
    const res = resolveTargets([roster[2]!, roster[0]!, roster[1]!], new Map(), T);
    expect(res.targets.map((t) => t.member.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('parseJoinUrl', () => {
  it('extracts threadId, organizer and tenant', () => {
    expect(parseJoinUrl(JOIN_URL)).toEqual({ threadId: '19:meeting_ABC123@thread.v2', organizerId: 'organizer-1', tenantId: 'tenant-1' });
  });

  it('rejects malformed URLs', () => {
    expect(() => parseJoinUrl('not a url')).toThrow();
    expect(() => parseJoinUrl('https://teams.microsoft.com/l/meetup-join/abc/0?context=%7b%7d')).toThrow();
    expect(() => parseJoinUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0')).toThrow(/context/);
    expect(() => parseJoinUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d')).toThrow(/Oid/);
  });
});
