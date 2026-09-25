#!/usr/bin/env node
// Validates statemachine/convocation.asl.json: Terraform placeholders, JSON syntax, state
// references (Next/Default/StartAt, recursively into Map/Parallel), state names and End states.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_PLACEHOLDERS = ['resolve_roster_arn', 'join_room_arn', 'invite_member_arn', 'check_joined_arn', 'evaluate_outcome_arn'];

const ILLEGAL_STATE_NAME = /[\s<>{}\[\]?*"#%\\^|~`$&,;:/]/;

export function substitutePlaceholders(text) {
  const errors = [];
  const seen = new Set();
  // Terraform templatefile: "${name}" is interpolation, "$${" is an escaped literal.
  const replaced = text.replace(/\$\$\{|\$\{([^}]*)\}/g, (match, name) => {
    if (match === '$${') return '${';
    const key = (name ?? '').trim();
    if (!REQUIRED_PLACEHOLDERS.includes(key)) {
      errors.push(`Placeholder no permitido: \${${key}}`);
      return match;
    }
    seen.add(key);
    return `arn:aws:lambda:us-east-1:000000000000:function:${key}`;
  });
  for (const p of REQUIRED_PLACEHOLDERS) if (!seen.has(p)) errors.push(`Falta el placeholder obligatorio \${${p}}`);
  return { text: replaced, errors };
}

function validateStates(container, path, errors) {
  const states = container.States;
  if (!states || typeof states !== 'object') {
    errors.push(`${path}: falta States`);
    return;
  }
  const names = new Set(Object.keys(states));
  const check = (ref, where) => {
    if (typeof ref !== 'string' || !names.has(ref)) errors.push(`${where}: referencia a estado inexistente "${ref}"`);
  };
  check(container.StartAt, `${path}.StartAt`);
  for (const [name, state] of Object.entries(states)) {
    const here = `${path}.States.${name}`;
    if (ILLEGAL_STATE_NAME.test(name) || name.length > 80) errors.push(`${here}: nombre de estado inválido`);
    if (!state || typeof state !== 'object' || typeof state.Type !== 'string') {
      errors.push(`${here}: falta Type`);
      continue;
    }
    const terminal = state.Type === 'Succeed' || state.Type === 'Fail';
    if (state.Type === 'Choice') {
      if (!Array.isArray(state.Choices) || state.Choices.length === 0) errors.push(`${here}: Choice sin Choices`);
      for (const [i, c] of (state.Choices ?? []).entries()) check(c.Next, `${here}.Choices[${i}].Next`);
      if (state.Default !== undefined) check(state.Default, `${here}.Default`);
      if (state.Next !== undefined) errors.push(`${here}: Choice no admite Next`);
    } else if (!terminal) {
      if (state.End === true && state.Next !== undefined) errors.push(`${here}: End y Next son excluyentes`);
      if (state.End !== true && state.Next === undefined) errors.push(`${here}: falta Next o End`);
      if (state.Next !== undefined) check(state.Next, `${here}.Next`);
    }
    for (const [i, c] of (state.Catch ?? []).entries()) check(c.Next, `${here}.Catch[${i}].Next`);
    if (state.Type === 'Task' && typeof state.Resource !== 'string') errors.push(`${here}: Task sin Resource`);
    if (state.Type === 'Map') {
      const inner = state.ItemProcessor ?? state.Iterator;
      if (!inner) errors.push(`${here}: Map sin ItemProcessor/Iterator`);
      else validateStates(inner, `${here}.ItemProcessor`, errors);
    }
    if (state.Type === 'Parallel') {
      if (!Array.isArray(state.Branches) || state.Branches.length === 0) errors.push(`${here}: Parallel sin Branches`);
      for (const [i, b] of (state.Branches ?? []).entries()) validateStates(b, `${here}.Branches[${i}]`, errors);
    }
  }
}

export function validateAsl(text) {
  const { text: rendered, errors } = substitutePlaceholders(text);
  if (/\$\{/.test(rendered.replace(/\$\$\{/g, ''))) {
    // any residual "${" would have been reported as a bad placeholder above
  }
  let definition;
  try {
    definition = JSON.parse(rendered);
  } catch (err) {
    errors.push(`JSON inválido: ${err.message}`);
    return { ok: false, errors, definition: undefined };
  }
  validateStates(definition, '$', errors);
  return { ok: errors.length === 0, errors, definition };
}

export const DEFAULT_ASL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'statemachine', 'convocation.asl.json');

export async function validateAslFile(path = DEFAULT_ASL_PATH) {
  return validateAsl(await readFile(path, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await validateAslFile(process.argv[2]);
  if (result.ok) {
    console.log('convocation.asl.json OK');
  } else {
    for (const e of result.errors) console.error(`- ${e}`);
    process.exit(1);
  }
}
