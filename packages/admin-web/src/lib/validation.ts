import type { TeamId } from '../api/types';
import { TEAM_IDS } from './labels';

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const isTeam = (v: string): v is TeamId => (TEAM_IDS as readonly string[]).includes(v);

/* ---------------------------- Reglas de severidad ---------------------------- */

export interface SeverityFormValues {
  severity: string;
  team_id: string;
  escalate_to_team_id: string; // '' = sin escalación
  escalate_after_minutes: string; // texto del input
  notify_webhook_urls: string; // una URL por línea
  enabled: boolean;
}

export type SeverityFormField = keyof SeverityFormValues;

export function splitUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateSeverityForm(values: SeverityFormValues): FieldErrors<SeverityFormField> {
  const errors: FieldErrors<SeverityFormField> = {};
  const severity = values.severity.trim();
  if (!severity) {
    errors.severity = 'La severidad es obligatoria.';
  } else if (!/^[a-z0-9_-]+$/.test(severity)) {
    errors.severity = 'Usa solo minúsculas, dígitos, guiones o guiones bajos (tal como llega de New Relic).';
  }

  if (!isTeam(values.team_id)) {
    errors.team_id = 'Selecciona el equipo convocado (N2 o N3).';
  }

  if (values.escalate_to_team_id) {
    if (!isTeam(values.escalate_to_team_id)) {
      errors.escalate_to_team_id = 'Equipo de escalación no válido.';
    } else if (values.escalate_to_team_id === values.team_id) {
      errors.escalate_to_team_id = 'El equipo de escalación debe ser distinto del equipo convocado.';
    }
  }

  const minutesText = values.escalate_after_minutes.trim();
  if (minutesText) {
    const n = Number(minutesText);
    if (!Number.isInteger(n) || n <= 0) {
      errors.escalate_after_minutes = 'Indica un número entero de minutos mayor que 0.';
    } else if (!values.escalate_to_team_id) {
      errors.escalate_after_minutes = 'Los minutos solo aplican si hay equipo de escalación.';
    }
  } else if (values.escalate_to_team_id) {
    errors.escalate_after_minutes = 'Indica tras cuántos minutos sin respuesta se escala.';
  }

  const bad = splitUrls(values.notify_webhook_urls).filter((u) => !isHttpsUrl(u));
  if (bad.length > 0) {
    errors.notify_webhook_urls = `URL no válida (debe ser https): ${bad[0] ?? ''}`;
  }
  return errors;
}

/* ------------------------------- Guardias ------------------------------- */

export interface RosterFormValues {
  member_id: string;
  team_id: string;
  priority_order: string;
  room_join_url: string;
}

export type RosterFormField = keyof RosterFormValues;

export function validateRosterForm(values: RosterFormValues): FieldErrors<RosterFormField> {
  const errors: FieldErrors<RosterFormField> = {};
  if (!values.member_id) errors.member_id = 'Selecciona un usuario.';
  if (!isTeam(values.team_id)) errors.team_id = 'Selecciona el equipo (N2 o N3).';
  const n = Number(values.priority_order);
  if (!values.priority_order.trim() || !Number.isInteger(n) || n < 1 || n > 999) {
    errors.priority_order = 'La prioridad debe ser un entero entre 1 y 999.';
  }
  const url = values.room_join_url.trim();
  if (!url) {
    errors.room_join_url = 'La URL de la sala de Teams es obligatoria.';
  } else if (!isHttpsUrl(url) || !/meetup-join/i.test(url)) {
    errors.room_join_url = 'Debe ser la URL "Unirse" de una reunión de Teams (https://teams.microsoft.com/l/meetup-join/…).';
  }
  return errors;
}

export const SYSTEM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validateSystemId(value: string): string | null {
  const v = value.trim();
  if (!v) return 'El identificador del sistema es obligatorio.';
  if (!SYSTEM_ID_PATTERN.test(v)) {
    return 'Usa minúsculas, dígitos, punto, guion o guion bajo (debe coincidir con el system_tag de New Relic).';
  }
  return null;
}

/* ----------------------------- Disponibilidad ----------------------------- */

export interface AvailabilityFormValues {
  member_id: string;
  status: string;
  valid_from: string; // ISO
  valid_until: string; // ISO
  backup_id: string;
}

export type AvailabilityFormField = keyof AvailabilityFormValues;

export function validateAvailabilityForm(values: AvailabilityFormValues): FieldErrors<AvailabilityFormField> {
  const errors: FieldErrors<AvailabilityFormField> = {};
  if (!values.member_id) errors.member_id = 'Selecciona el miembro.';
  if (!['available', 'vacation', 'unavailable'].includes(values.status)) {
    errors.status = 'Selecciona un estado.';
  }
  if (!values.valid_from) errors.valid_from = 'Indica el inicio.';
  if (!values.valid_until) errors.valid_until = 'Indica el fin.';
  if (values.valid_from && values.valid_until && values.valid_from >= values.valid_until) {
    errors.valid_until = 'El fin debe ser posterior al inicio.';
  }
  if (values.backup_id && values.backup_id === values.member_id) {
    errors.backup_id = 'El backup no puede ser la misma persona.';
  }
  return errors;
}
