import { describe, expect, it } from 'vitest';
import { decideOutcome } from '../src/domain/outcome.js';
import type { SlotResult } from '../src/domain/types.js';

const m = { id: 'a', upn: 'a@x', name: 'A' };
const joined: SlotResult = { slot: 1, member: m, outcome: 'joined' };
const exhausted: SlotResult = { slot: 2, member: m, outcome: 'exhausted' };

describe('decideOutcome', () => {
  it('is connected when at least one slot joined', () => {
    expect(decideOutcome({ slot_results: [exhausted, joined], escalate_to_team_id: 'N3', escalation_count: 0, max_escalations: 1 })).toMatchObject({ outcome: 'connected', escalation_count: 0, joined_count: 1 });
  });
  it('escalates when nobody joined and escalation is allowed', () => {
    expect(decideOutcome({ slot_results: [exhausted], escalate_to_team_id: 'N3', escalation_count: 0, max_escalations: 1 })).toMatchObject({ outcome: 'escalate', next_team_id: 'N3', escalation_count: 1 });
  });
  it('is unanswered when escalation budget is spent, no target, or empty results', () => {
    expect(decideOutcome({ slot_results: [exhausted], escalate_to_team_id: 'N3', escalation_count: 1, max_escalations: 1 }).outcome).toBe('unanswered');
    expect(decideOutcome({ slot_results: [exhausted], escalate_to_team_id: null, escalation_count: 0, max_escalations: 1 }).outcome).toBe('unanswered');
    expect(decideOutcome({ slot_results: [], escalate_to_team_id: undefined, escalation_count: 0, max_escalations: 1 }).outcome).toBe('unanswered');
  });
  it('escalates with empty results (no eligible members) when a target exists', () => {
    expect(decideOutcome({ slot_results: [], escalate_to_team_id: 'N3', escalation_count: 0, max_escalations: 1 }).outcome).toBe('escalate');
  });
  it('never escalates when forced unanswered (room join failed)', () => {
    expect(decideOutcome({ slot_results: [], escalate_to_team_id: 'N3', escalation_count: 0, max_escalations: 1, force_unanswered: true }).outcome).toBe('unanswered');
  });
});
