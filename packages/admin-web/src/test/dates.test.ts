import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, fromLocalInputValue, isWithin, toLocalInputValue } from '../lib/dates';

describe('formatDateTime', () => {
  it('muestra la fecha ISO UTC en la zona horaria indicada', () => {
    const out = formatDateTime('2026-09-23T18:03:11.000Z', { timeZone: 'America/Bogota' });
    expect(out).toContain('23/09/2026');
    expect(out).toContain('13:03');
  });

  it('muestra un guion largo para valores vacíos o inválidos', () => {
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('no-es-fecha')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formatea minutos, horas y días', () => {
    expect(formatDuration('2026-09-23T18:00:00Z', '2026-09-23T18:47:00Z')).toBe('47 min');
    expect(formatDuration('2026-09-23T18:00:00Z', '2026-09-23T19:25:00Z')).toBe('1 h 25 min');
    expect(formatDuration('2026-09-23T18:00:00Z', '2026-09-25T21:00:00Z')).toBe('2 d 3 h');
    expect(formatDuration('2026-09-23T18:00:00Z', '2026-09-23T18:00:20Z')).toBe('< 1 min');
  });

  it('usa "ahora" cuando no hay fin', () => {
    const now = new Date('2026-09-23T20:00:00Z');
    expect(formatDuration('2026-09-23T18:00:00Z', null, now)).toBe('2 h');
  });
});

describe('datetime-local <-> ISO', () => {
  it('hace ida y vuelta conservando el instante', () => {
    const iso = '2026-09-24T12:30:00.000Z';
    const local = toLocalInputValue(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInputValue(local)).toBe(iso);
  });

  it('devuelve vacío / null para entradas inválidas', () => {
    expect(toLocalInputValue(undefined)).toBe('');
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('garbage')).toBeNull();
  });
});

describe('isWithin', () => {
  it('es inclusivo en el inicio y exclusivo en el fin', () => {
    const from = '2026-09-21T00:00:00Z';
    const until = '2026-10-05T00:00:00Z';
    expect(isWithin(from, until, new Date(from))).toBe(true);
    expect(isWithin(from, until, new Date('2026-09-30T00:00:00Z'))).toBe(true);
    expect(isWithin(from, until, new Date(until))).toBe(false);
  });
});
