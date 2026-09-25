// evaluate-outcome decision (ARCHITECTURE.md 3.2) as a pure function.
import type { ConvocationOutcome, SlotResult, TeamId } from './types.js';

export interface OutcomeDecisionInput {
  slot_results: readonly SlotResult[];
  escalate_to_team_id: TeamId | null | undefined;
  escalation_count: number;
  max_escalations: number;
  /** When the room could not be joined the cycle ends as `unanswered` without escalating. */
  force_unanswered?: boolean;
}

export interface OutcomeDecision {
  outcome: ConvocationOutcome;
  next_team_id?: TeamId;
  escalation_count: number;
  joined_count: number;
}

export function decideOutcome(input: OutcomeDecisionInput): OutcomeDecision {
  const joined = input.slot_results.filter((r) => r.outcome === 'joined').length;
  if (joined >= 1) {
    return { outcome: 'connected', escalation_count: input.escalation_count, joined_count: joined };
  }
  const canEscalate =
    !input.force_unanswered && !!input.escalate_to_team_id && input.escalation_count < input.max_escalations;
  if (canEscalate && input.escalate_to_team_id) {
    return {
      outcome: 'escalate',
      next_team_id: input.escalate_to_team_id,
      escalation_count: input.escalation_count + 1,
      joined_count: 0,
    };
  }
  return { outcome: 'unanswered', escalation_count: input.escalation_count, joined_count: 0 };
}
