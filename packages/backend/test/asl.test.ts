import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ASL_PATH, REQUIRED_PLACEHOLDERS, validateAsl, validateAslFile } from '../scripts/validate-asl.mjs';

describe('convocation.asl.json', () => {
  it('is valid and only uses the five Terraform placeholders', async () => {
    const result = await validateAslFile();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const text = await readFile(DEFAULT_ASL_PATH, 'utf8');
    const placeholders = [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    expect(new Set(placeholders)).toEqual(new Set(REQUIRED_PLACEHOLDERS));
  });

  it('has the required top-level states and iterator states', async () => {
    const { definition } = await validateAslFile();
    const def = definition as { StartAt: string; TimeoutSeconds: number; States: Record<string, { Type: string; ItemProcessor?: { States: Record<string, unknown> }; ResultPath?: string }> };
    expect(def.StartAt).toBe('ResolveRoster');
    expect(def.TimeoutSeconds).toBe(7200);
    for (const s of ['ResolveRoster', 'JoinRoom', 'ConvokeTeam', 'EvaluateOutcome', 'ShouldEscalate', 'PrepareEscalation', 'Done']) expect(def.States[s]).toBeDefined();
    const map = def.States['ConvokeTeam']!;
    expect(map.Type).toBe('Map');
    expect(map.ResultPath).toBe('$.slot_results');
    for (const s of ['InitSlot', 'Invite', 'WaitRing', 'CheckJoined', 'Decide', 'NextAttempt', 'SwitchToBackup', 'SlotJoined', 'SlotTimedOut', 'SlotExhausted', 'SlotError']) {
      expect(map.ItemProcessor?.States[s]).toBeDefined();
    }
  });

  it('detects dangling references, unknown placeholders and invalid names', () => {
    const base = { StartAt: 'A', States: { A: { Type: 'Task', Resource: '${resolve_roster_arn}', Next: 'Missing' } } };
    const r = validateAsl(JSON.stringify(base));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('Missing'))).toBe(true);
    const bad = validateAsl(JSON.stringify({ StartAt: 'Bad?Name', States: { 'Bad?Name': { Type: 'Task', Resource: '${other}', End: true } } }));
    expect(bad.errors.some((e) => e.includes('Placeholder no permitido'))).toBe(true);
    expect(bad.errors.some((e) => e.includes('nombre de estado inválido'))).toBe(true);
  });

  it('accepts escaped $${ literals', () => {
    const text = JSON.stringify({ StartAt: 'A', States: { A: { Type: 'Pass', Result: 'literal $${x}', End: true } } });
    const r = validateAsl(text);
    expect(r.errors.filter((e) => e.includes('no permitido'))).toEqual([]);
  });
});
