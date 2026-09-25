// Pure business rules: normalisation, severity -> team, availability/backup substitution,
// cascade and Teams join-URL parsing. No I/O here.
import type { AvailabilityItem, Member, RosterItem, SeverityRule, Target, TeamId } from './types.js';
import { TEAM_IDS } from './types.js';

export function normalizeSystemId(systemTag: string): string {
  return systemTag.trim().toLowerCase();
}

export function normalizeSeverity(severity: string): string {
  return severity.trim().toLowerCase();
}

export function isTeamId(value: unknown): value is TeamId {
  return typeof value === 'string' && (TEAM_IDS as readonly string[]).includes(value);
}

export type SeverityDecision =
  | { kind: 'ignored'; reason: 'no_severity_rule' | 'severity_disabled' }
  | { kind: 'convoke'; rule: SeverityRule; team_id: TeamId };

/** Steps 4 of the webhook rules: which team (if any) a severity convokes. */
export function resolveTeamForSeverity(rule: SeverityRule | undefined): SeverityDecision {
  if (!rule) return { kind: 'ignored', reason: 'no_severity_rule' };
  if (!rule.enabled) return { kind: 'ignored', reason: 'severity_disabled' };
  return { kind: 'convoke', rule, team_id: rule.team_id };
}

/** Escalation target for a team: the rule's target unless it is the same team. */
export function escalationTargetFor(rule: SeverityRule | undefined, currentTeam: TeamId): TeamId | null {
  if (!rule?.escalate_to_team_id) return null;
  return rule.escalate_to_team_id === currentTeam ? null : rule.escalate_to_team_id;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function toMillis(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/** True when `valid_from <= t < valid_until` (ISO 8601 UTC strings). */
export function isWindowActive(record: Pick<AvailabilityItem, 'valid_from' | 'valid_until'>, at: string): boolean {
  const t = toMillis(at);
  const from = toMillis(record.valid_from);
  const until = toMillis(record.valid_until);
  if (Number.isNaN(t) || Number.isNaN(from) || Number.isNaN(until)) return false;
  return from <= t && t < until;
}

/** Records whose window contains `at`, most recent `valid_from` first. */
export function activeRecordsAt(records: readonly AvailabilityItem[], at: string): AvailabilityItem[] {
  return records
    .filter((r) => isWindowActive(r, at))
    .sort((a, b) => (a.valid_from < b.valid_from ? 1 : a.valid_from > b.valid_from ? -1 : 0));
}

/** The record that makes a member unavailable at `at`, if any (section 2.2 rule). */
export function unavailabilityAt(records: readonly AvailabilityItem[], at: string): AvailabilityItem | undefined {
  return activeRecordsAt(records, at).find((r) => r.status !== 'available');
}

export function isUnavailableAt(records: readonly AvailabilityItem[], at: string): boolean {
  return unavailabilityAt(records, at) !== undefined;
}

/**
 * Designated backup of a member at `at`. Taken from the active unavailability record if there is one,
 * otherwise from an active `available` record that declares a standing backup (the way to configure a
 * backup for a member who is on duty).
 */
export function backupAt(records: readonly AvailabilityItem[], at: string): Member | null {
  const active = activeRecordsAt(records, at);
  const source = active.find((r) => r.status !== 'available' && r.backup_id) ?? active.find((r) => r.backup_id);
  if (!source?.backup_id) return null;
  return { id: source.backup_id, upn: source.backup_upn ?? '', name: source.backup_name ?? source.backup_upn ?? source.backup_id };
}

export function memberFromRoster(item: RosterItem): Member {
  return { id: item.member_id, upn: item.member_upn, name: item.member_name };
}

export interface SkippedSlot {
  slot: number;
  member: Member;
  backup: Member | null;
  reason: 'member_and_backup_unavailable' | 'member_unavailable_no_backup';
}

export interface SubstitutedSlot {
  slot: number;
  member: Member;
  backup: Member;
}

export interface RosterResolution {
  targets: Target[];
  skipped: SkippedSlot[];
  substituted: SubstitutedSlot[];
}

/** Sort roster rows by priority, then by roster_key for a deterministic order. */
export function sortRoster(items: readonly RosterItem[]): RosterItem[] {
  return [...items].sort((a, b) => a.priority_order - b.priority_order || (a.roster_key < b.roster_key ? -1 : a.roster_key > b.roster_key ? 1 : 0));
}

/**
 * Applies the availability/backup rules to a team roster at instant `at`:
 * - available member -> target is the member, backup (if any) kept for the retry policy;
 * - unavailable member with available backup -> target is the backup (`substituted=true`, `backup=null`);
 * - unavailable member with no backup or unavailable backup -> slot skipped (cascade to the next one).
 * Slot numbers follow the roster order (1-based) and are kept stable even when slots are skipped.
 */
export function resolveTargets(
  roster: readonly RosterItem[],
  availability: ReadonlyMap<string, readonly AvailabilityItem[]>,
  at: string,
): RosterResolution {
  const targets: Target[] = [];
  const skipped: SkippedSlot[] = [];
  const substituted: SubstitutedSlot[] = [];
  const seenMembers = new Set<string>();

  sortRoster(roster).forEach((item, index) => {
    const slot = index + 1;
    const member = memberFromRoster(item);
    const memberRecords = availability.get(member.id) ?? [];
    const backup = backupAt(memberRecords, at);
    const backupUnavailable = backup ? isUnavailableAt(availability.get(backup.id) ?? [], at) : false;

    if (isUnavailableAt(memberRecords, at)) {
      if (!backup) {
        skipped.push({ slot, member, backup: null, reason: 'member_unavailable_no_backup' });
        return;
      }
      if (backupUnavailable) {
        skipped.push({ slot, member, backup, reason: 'member_and_backup_unavailable' });
        return;
      }
      if (seenMembers.has(backup.id)) return; // already being called through another slot
      seenMembers.add(backup.id);
      substituted.push({ slot, member, backup });
      targets.push({ slot, member: backup, backup: null, substituted: true });
      return;
    }

    if (seenMembers.has(member.id)) return;
    seenMembers.add(member.id);
    targets.push({ slot, member, backup: backup && !backupUnavailable ? backup : null, substituted: false });
  });

  return { targets, skipped, substituted };
}

// ---------------------------------------------------------------------------
// Teams join URL
// ---------------------------------------------------------------------------

export interface JoinUrlParts {
  threadId: string;
  organizerId: string;
  tenantId: string;
}

/**
 * Parses a Teams "Join" URL such as
 * https://teams.microsoft.com/l/meetup-join/19%3ameeting_XXX%40thread.v2/0?context=%7b%22Tid%22%3a%22...%22%2c%22Oid%22%3a%22...%22%7d
 */
export function parseJoinUrl(joinUrl: string): JoinUrlParts {
  let url: URL;
  try {
    url = new URL(joinUrl);
  } catch {
    throw new Error('room_join_url no es una URL válida');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const idx = segments.findIndex((s) => s === 'meetup-join');
  const rawThread = idx >= 0 ? segments[idx + 1] : undefined;
  if (!rawThread) throw new Error('room_join_url no contiene el segmento meetup-join/{threadId}');
  const threadId = safeDecode(rawThread);
  if (!/^19:.+@thread\.(v2|tacv2|skype)$/i.test(threadId)) {
    throw new Error('room_join_url no contiene un threadId de reunión válido');
  }
  const context = url.searchParams.get('context');
  if (!context) throw new Error('room_join_url no contiene el parámetro context');
  let parsed: unknown;
  try {
    parsed = JSON.parse(context);
  } catch {
    throw new Error('room_join_url: el parámetro context no es JSON válido');
  }
  const tenantId = readStringProp(parsed, 'Tid');
  const organizerId = readStringProp(parsed, 'Oid');
  if (!tenantId || !organizerId) throw new Error('room_join_url: context sin Tid u Oid');
  return { threadId, organizerId, tenantId };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readStringProp(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
