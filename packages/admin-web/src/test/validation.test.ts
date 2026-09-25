import { describe, expect, it } from 'vitest';
import {
  splitUrls,
  validateAvailabilityForm,
  validateRosterForm,
  validateSeverityForm,
  validateSystemId,
  type SeverityFormValues,
} from '../lib/validation';

const valid: SeverityFormValues = {
  severity: 'high',
  team_id: 'N2',
  escalate_to_team_id: 'N3',
  escalate_after_minutes: '10',
  notify_webhook_urls: 'https://contoso.webhook.office.com/webhookb2/abc\n\n  https://example.com/hook  ',
  enabled: true,
};

describe('validateSeverityForm', () => {
  it('acepta un formulario correcto', () => {
    expect(validateSeverityForm(valid)).toEqual({});
  });

  it('exige severidad en minúsculas sin espacios', () => {
    expect(validateSeverityForm({ ...valid, severity: '' }).severity).toMatch(/obligatoria/);
    expect(validateSeverityForm({ ...valid, severity: 'Critical' }).severity).toMatch(/minúsculas/);
    expect(validateSeverityForm({ ...valid, severity: 'muy alta' }).severity).toMatch(/minúsculas/);
  });

  it('rechaza equipo inválido y escalación al mismo equipo', () => {
    expect(validateSeverityForm({ ...valid, team_id: 'N9' }).team_id).toBeDefined();
    expect(validateSeverityForm({ ...valid, escalate_to_team_id: 'N2' }).escalate_to_team_id).toMatch(/distinto/);
  });

  it('valida la coherencia entre escalación y minutos', () => {
    expect(validateSeverityForm({ ...valid, escalate_after_minutes: '' }).escalate_after_minutes).toMatch(/minutos/);
    expect(validateSeverityForm({ ...valid, escalate_after_minutes: '0' }).escalate_after_minutes).toMatch(/mayor que 0/);
    expect(validateSeverityForm({ ...valid, escalate_after_minutes: '2.5' }).escalate_after_minutes).toMatch(/entero/);
    expect(
      validateSeverityForm({ ...valid, escalate_to_team_id: '', escalate_after_minutes: '10' }).escalate_after_minutes,
    ).toMatch(/solo aplican/);
    expect(validateSeverityForm({ ...valid, escalate_to_team_id: '', escalate_after_minutes: '' })).toEqual({});
  });

  it('exige URLs https en los webhooks', () => {
    const errs = validateSeverityForm({ ...valid, notify_webhook_urls: 'https://ok.example\nhttp://insecure.example' });
    expect(errs.notify_webhook_urls).toContain('http://insecure.example');
    expect(validateSeverityForm({ ...valid, notify_webhook_urls: 'no es url' }).notify_webhook_urls).toBeDefined();
  });
});

describe('splitUrls', () => {
  it('separa por líneas, recorta y descarta vacías', () => {
    expect(splitUrls(valid.notify_webhook_urls)).toEqual([
      'https://contoso.webhook.office.com/webhookb2/abc',
      'https://example.com/hook',
    ]);
  });
});

describe('validateRosterForm', () => {
  it('valida usuario, equipo, prioridad y URL de sala', () => {
    const errs = validateRosterForm({ member_id: '', team_id: 'N1', priority_order: '0', room_join_url: 'https://x.y' });
    expect(errs.member_id).toBeDefined();
    expect(errs.team_id).toBeDefined();
    expect(errs.priority_order).toBeDefined();
    expect(errs.room_join_url).toMatch(/meetup-join/);
    expect(
      validateRosterForm({
        member_id: 'abc',
        team_id: 'N3',
        priority_order: '2',
        room_join_url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d',
      }),
    ).toEqual({});
  });
});

describe('validateSystemId', () => {
  it('acepta identificadores tipo system_tag y rechaza el resto', () => {
    expect(validateSystemId('payments-api')).toBeNull();
    expect(validateSystemId('Payments API')).toMatch(/minúsculas/);
    expect(validateSystemId('')).toMatch(/obligatorio/);
  });
});

describe('validateAvailabilityForm', () => {
  it('exige rango coherente y backup distinto', () => {
    const errs = validateAvailabilityForm({
      member_id: 'a',
      status: 'vacation',
      valid_from: '2026-10-05T00:00:00.000Z',
      valid_until: '2026-10-01T00:00:00.000Z',
      backup_id: 'a',
    });
    expect(errs.valid_until).toMatch(/posterior/);
    expect(errs.backup_id).toMatch(/misma persona/);
  });
});
