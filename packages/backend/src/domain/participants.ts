// Roster diffing: humans currently in the room vs. what the incident recorded.
import type { Participant } from './types.js';

export interface RosterDiff {
  participants: Participant[];
  joined: Participant[];
  left: Participant[];
}

export interface HumanParticipant {
  id: string;
  display_name: string;
}

/** Computes the new participant list preserving `joined_at` of the ones who were already present. */
export function diffParticipants(previous: readonly Participant[], humans: readonly HumanParticipant[], now: string): RosterDiff {
  const prevById = new Map(previous.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const participants: Participant[] = [];
  const joined: Participant[] = [];
  for (const h of humans) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    const existing = prevById.get(h.id);
    if (existing) {
      participants.push({ ...existing, display_name: h.display_name || existing.display_name });
    } else {
      const p: Participant = { id: h.id, display_name: h.display_name, joined_at: now };
      participants.push(p);
      joined.push(p);
    }
  }
  const left = previous.filter((p) => !seen.has(p.id));
  return { participants, joined, left };
}

export function hasParticipant(participants: readonly Participant[], memberId: string): boolean {
  return participants.some((p) => p.id === memberId);
}
