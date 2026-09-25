// Webhook deduplication decisions (ARCHITECTURE.md 3.1, steps 3-7) as pure functions.
import type { Incident, LockItem, SeverityRule, WebhookPayload } from './types.js';
import { resolveTeamForSeverity } from './rules.js';

export type IgnoreReason = 'state_not_open' | 'no_severity_rule' | 'severity_disabled' | 'no_roster';

export type PreLockDecision =
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'proceed'; rule: SeverityRule };

/**
 * Steps 3-5: state must be open, severity must be enabled and the team must have a roster.
 * `rosterCount` is only consulted when the rule resolves a team.
 */
export function decideBeforeLock(payload: WebhookPayload, rule: SeverityRule | undefined, rosterCount: number): PreLockDecision {
  if (payload.current_state.trim().toLowerCase() !== 'open') return { kind: 'ignored', reason: 'state_not_open' };
  const severity = resolveTeamForSeverity(rule);
  if (severity.kind === 'ignored') return { kind: 'ignored', reason: severity.reason };
  if (rosterCount <= 0) return { kind: 'ignored', reason: 'no_roster' };
  return { kind: 'proceed', rule: severity.rule };
}

export type LockDecision =
  | { kind: 'convoke'; stale_lock: boolean }
  | { kind: 'echo'; incident: Incident }
  | { kind: 'check_participants'; incident: Incident }
  | { kind: 'close_and_convoke'; incident: Incident; close_reason: 'empty_on_new_alert' };

/**
 * Step 6: what to do when a lock for the system may already exist.
 * For a `connected` incident the caller must supply `humanCount` (from Graph); until it does the
 * decision is `check_participants`.
 */
export function decideOnLock(lock: LockItem | undefined, incident: Incident | undefined, humanCount?: number): LockDecision {
  if (!lock) return { kind: 'convoke', stale_lock: false };
  if (!incident) return { kind: 'convoke', stale_lock: true }; // orphan lock without incident
  switch (incident.status) {
    case 'convoking':
      return { kind: 'echo', incident };
    case 'connected':
      if (humanCount === undefined) return { kind: 'check_participants', incident };
      if (humanCount >= 1) return { kind: 'echo', incident };
      return { kind: 'close_and_convoke', incident, close_reason: 'empty_on_new_alert' };
    case 'unanswered':
    case 'closed':
      return { kind: 'convoke', stale_lock: true };
    default:
      return { kind: 'convoke', stale_lock: true };
  }
}

/** Lock TTL: 24 h safety net (epoch seconds). */
export function lockTtlFor(now: Date): number {
  return Math.floor(now.getTime() / 1000) + 24 * 60 * 60;
}
