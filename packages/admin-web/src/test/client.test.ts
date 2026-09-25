import { describe, expect, it, vi } from 'vitest';
import { ApiError, buildUrl, createHttpClient } from '../api/client';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeFetch(status: number, body: unknown, captured: Captured[]) {
  const fetchFn: typeof fetch = (input, init) => {
    captured.push({ url: String(input), init: init ?? {} });
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(
      new Response(text, { status, headers: { 'Content-Type': 'application/json' } }),
    );
  };
  return fetchFn;
}

const BASE = 'https://api.example.com/';

describe('buildUrl', () => {
  it('quita la barra final y codifica la query, omitiendo valores vacíos', () => {
    expect(buildUrl(BASE, '/admin/roster', { system_id: 'payments-api', cursor: undefined, x: '' })).toBe(
      'https://api.example.com/admin/roster?system_id=payments-api',
    );
    expect(buildUrl('https://api.example.com', '/admin/me')).toBe('https://api.example.com/admin/me');
  });
});

describe('createHttpClient', () => {
  it('envía Authorization: Bearer con el token y construye la URL de GET', async () => {
    const captured: Captured[] = [];
    const getToken = vi.fn(() => Promise.resolve('tok-123'));
    const api = createHttpClient({ baseUrl: BASE, getToken, fetchFn: makeFetch(200, { items: [] }, captured) });

    const items = await api.listRoster('payments-api');

    expect(items).toEqual([]);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(captured[0]?.url).toBe('https://api.example.com/admin/roster?system_id=payments-api');
    expect(captured[0]?.init.method).toBe('GET');
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('serializa cuerpos JSON en PUT y devuelve `item`', async () => {
    const captured: Captured[] = [];
    const rule = {
      severity: 'high',
      team_id: 'N2' as const,
      escalate_to_team_id: 'N3' as const,
      escalate_after_minutes: 10,
      notify_webhook_urls: [],
      enabled: true,
    };
    const api = createHttpClient({
      baseUrl: BASE,
      getToken: () => Promise.resolve('t'),
      fetchFn: makeFetch(200, { item: { ...rule, updated_at: 'x', updated_by: 'y' } }, captured),
    });

    const saved = await api.putSeverityRule(rule);

    expect(saved.updated_by).toBe('y');
    expect(captured[0]?.url).toBe('https://api.example.com/admin/severity-rules');
    expect(captured[0]?.init.method).toBe('PUT');
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual(rule);
  });

  it('codifica los parámetros de DELETE y el id de incidente en la ruta', async () => {
    const captured: Captured[] = [];
    const api = createHttpClient({
      baseUrl: BASE,
      getToken: () => Promise.resolve('t'),
      fetchFn: makeFetch(200, { ok: true, incident: {}, events: [] }, captured),
    });

    await api.deleteRoster('payments-api', 'N2#001#abc');
    await api.deleteAvailability('m1', '2026-09-24T00:00:00.000Z');
    await api.getIncident('01J8Q/ID');
    await api.listIncidents({ status: 'closed', system_id: 'checkout-web' });
    await api.listAudit();

    expect(captured[0]?.url).toBe('https://api.example.com/admin/roster?system_id=payments-api&roster_key=N2%23001%23abc');
    expect(captured[0]?.init.method).toBe('DELETE');
    expect(captured[1]?.url).toBe(
      'https://api.example.com/admin/availability?member_id=m1&valid_from=2026-09-24T00%3A00%3A00.000Z',
    );
    expect(captured[2]?.url).toBe('https://api.example.com/admin/incidents/01J8Q%2FID');
    expect(captured[3]?.url).toBe(
      'https://api.example.com/admin/incidents?system_id=checkout-web&status=closed&limit=50',
    );
    expect(captured[4]?.url).toBe('https://api.example.com/admin/audit?incident_id=ADMIN');
  });

  it('convierte `{ error }` en ApiError con el status', async () => {
    const api = createHttpClient({
      baseUrl: BASE,
      getToken: () => Promise.resolve('t'),
      fetchFn: makeFetch(403, { error: 'No perteneces al grupo de administradores' }, []),
    });

    const err = await api.getMe().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe('No perteneces al grupo de administradores');
  });

  it('usa un mensaje por defecto cuando el cuerpo de error no es JSON', async () => {
    const api = createHttpClient({
      baseUrl: BASE,
      getToken: () => Promise.resolve('t'),
      fetchFn: makeFetch(500, '<html>boom</html>', []),
    });

    const err = await api.listSystems().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toMatch(/HTTP 500/);
  });

  it('envuelve fallos de red en ApiError con status 0', async () => {
    const api = createHttpClient({
      baseUrl: BASE,
      getToken: () => Promise.resolve('t'),
      fetchFn: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    const err = await api.listSystems().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toMatch(/Failed to fetch/);
  });
});
