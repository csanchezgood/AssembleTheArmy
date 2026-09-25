import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimAsList, handler, userFromClaims } from '../src/handlers/admin-api.js';
import type { FakeDynamo } from './fake-dynamo.js';
import { adminEvent, auditTypes, createFakeDynamo, incident, JOIN_URL, json, mockFetch, mockSecrets, rosterItem, rule, seedIncident, setBaseEnv, TABLES, tokenRoute } from './helpers.js';

let db: FakeDynamo;
const parse = (res: { body?: string }) => JSON.parse(res.body ?? 'null') as Record<string, unknown>;

beforeEach(() => {
  setBaseEnv();
  mockSecrets();
  mockFetch([tokenRoute]);
  db = createFakeDynamo();
});

afterEach(() => db.restore());

describe('claims handling', () => {
  it('parses API Gateway string-encoded arrays and real arrays', () => {
    expect(claimAsList('[a b]')).toEqual(['a', 'b']);
    expect(claimAsList('[a, b]')).toEqual(['a', 'b']);
    expect(claimAsList('["a","b"]')).toEqual(['a', 'b']);
    expect(claimAsList(['a'])).toEqual(['a']);
    expect(claimAsList('single')).toEqual(['single']);
    expect(claimAsList(undefined)).toEqual([]);
  });

  it('accepts groups or roles and allows anyone when no group is configured', () => {
    expect(userFromClaims({ preferred_username: 'a@x', name: 'A', groups: '[g1 g2]' }, 'g2')).toEqual({ upn: 'a@x', name: 'A', is_admin: true });
    expect(userFromClaims({ upn: 'a@x', roles: ['g2'] }, 'g2')).toMatchObject({ is_admin: true, name: 'a@x' });
    expect(userFromClaims({ email: 'a@x', groups: '[g1]' }, 'g2').is_admin).toBe(false);
    expect(userFromClaims({ email: 'a@x' }, '').is_admin).toBe(true);
  });
});

describe('admin-api handler', () => {
  it('returns 403 with CORS headers when the user is not in the admin group', async () => {
    const res = await handler(adminEvent({ path: '/admin/me', claims: { preferred_username: 'x@x', groups: '[other]' } }));
    expect(res.statusCode).toBe(403);
    expect(parse(res)).toEqual({ error: expect.stringContaining('No autorizado') });
    expect(res.headers).toMatchObject({ 'access-control-allow-origin': 'https://admin.example.com' });
  });

  it('GET /admin/me returns the caller', async () => {
    const res = await handler(adminEvent({ path: '/admin/me' }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ upn: 'ana@example.com', name: 'Ana Admin', is_admin: true });
  });

  it('returns 404 for unknown routes and 204 for OPTIONS', async () => {
    expect((await handler(adminEvent({ path: '/admin/nope' }))).statusCode).toBe(404);
    expect((await handler(adminEvent({ method: 'OPTIONS', path: '/admin/me' }))).statusCode).toBe(204);
  });

  it('roster: PUT upserts with a computed roster_key and audits, GET lists sorted, DELETE removes', async () => {
    const put = await handler(adminEvent({ method: 'PUT', path: '/admin/roster', body: { system_id: 'Payments-API', team_id: 'N2', priority_order: 2, member_id: 'm2', member_upn: 'm2@x', member_name: 'Dos', room_join_url: JOIN_URL } }));
    expect(put.statusCode).toBe(200);
    expect(parse(put)['item']).toMatchObject({ system_id: 'payments-api', roster_key: 'N2#002#m2', updated_by: 'ana@example.com' });
    db.seed(TABLES.roster, [rosterItem({ team_id: 'N3', member_id: 'm9', priority_order: 1 }), rosterItem({ team_id: 'N2', member_id: 'm1', priority_order: 1 })]);

    const list = parse(await handler(adminEvent({ path: '/admin/roster', query: { system_id: 'payments-api' } })));
    expect((list['items'] as { roster_key: string }[]).map((i) => i.roster_key)).toEqual(['N2#001#m1', 'N2#002#m2', 'N3#001#m9']);

    const systems = parse(await handler(adminEvent({ path: '/admin/systems' })));
    expect(systems).toEqual({ systems: [{ system_id: 'payments-api', teams: ['N2', 'N3'], member_count: 3 }] });

    const del = await handler(adminEvent({ method: 'DELETE', path: '/admin/roster', query: { system_id: 'payments-api', roster_key: 'N2#002#m2' } }));
    expect(parse(del)).toEqual({ ok: true });
    expect(db.items(TABLES.roster)).toHaveLength(2);

    const audits = db.items(TABLES.audit).filter((e) => e['incident_id'] === 'ADMIN');
    expect(audits.map((e) => [e['event_type'], e['actor']])).toEqual([['config_changed', 'admin:ana@example.com'], ['config_changed', 'admin:ana@example.com']]);
    expect(audits[1]!['details']).toMatchObject({ table: 'roster', action: 'delete', roster_key: 'N2#002#m2' });
  });

  it('roster: rejects invalid bodies with 400', async () => {
    const bad = await handler(adminEvent({ method: 'PUT', path: '/admin/roster', body: { system_id: 'x', team_id: 'N4', priority_order: 1, member_id: 'm', member_upn: 'u', member_name: 'n', room_join_url: JOIN_URL } }));
    expect(bad.statusCode).toBe(400);
    const badUrl = await handler(adminEvent({ method: 'PUT', path: '/admin/roster', body: { system_id: 'x', team_id: 'N2', priority_order: 1, member_id: 'm', member_upn: 'u', member_name: 'n', room_join_url: 'https://example.com' } }));
    expect(badUrl.statusCode).toBe(400);
    expect((await handler(adminEvent({ method: 'PUT', path: '/admin/roster', body: 'nope' }))).statusCode).toBe(400);
    expect(db.items(TABLES.audit)).toHaveLength(0);
  });

  it('availability: PUT validates and stores, GET filters by member, DELETE removes', async () => {
    const put = await handler(adminEvent({ method: 'PUT', path: '/admin/availability', body: { member_id: 'm1', valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-10-15T00:00:00Z', status: 'vacation', backup_id: 'b1', backup_upn: 'b1@x', backup_name: 'B', note: 'Vacaciones' } }));
    expect(put.statusCode).toBe(200);
    expect(parse(put)['item']).toMatchObject({ member_id: 'm1', valid_from: '2026-10-01T00:00:00.000Z', status: 'vacation', backup_id: 'b1' });
    expect((await handler(adminEvent({ method: 'PUT', path: '/admin/availability', body: { member_id: 'm1', valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-10-15T00:00:00Z', status: 'vacation' } }))).statusCode).toBe(400);
    expect((await handler(adminEvent({ method: 'PUT', path: '/admin/availability', body: { member_id: 'm1', valid_from: '2026-10-16T00:00:00Z', valid_until: '2026-10-15T00:00:00Z', status: 'available' } }))).statusCode).toBe(400);
    const list = parse(await handler(adminEvent({ path: '/admin/availability', query: { member_id: 'm1' } })));
    expect(list['items']).toHaveLength(1);
    const all = parse(await handler(adminEvent({ path: '/admin/availability' })));
    expect(all['items']).toHaveLength(1);
    expect(parse(await handler(adminEvent({ method: 'DELETE', path: '/admin/availability', query: { member_id: 'm1', valid_from: '2026-10-01T00:00:00.000Z' } })))).toEqual({ ok: true });
    expect(db.items(TABLES.availability)).toHaveLength(0);
    expect(auditTypes(db, 'ADMIN')).toEqual(['config_changed', 'config_changed']);
  });

  it('severity rules: PUT normalises and validates, GET lists, DELETE removes', async () => {
    const put = await handler(adminEvent({ method: 'PUT', path: '/admin/severity-rules', body: { severity: 'High', team_id: 'N2', escalate_to_team_id: 'N3', escalate_after_minutes: 10, notify_webhook_urls: ['https://hook/a'], enabled: true } }));
    expect(parse(put)['item']).toMatchObject({ severity: 'high', team_id: 'N2', escalate_to_team_id: 'N3', escalate_after_minutes: 10 });
    expect((await handler(adminEvent({ method: 'PUT', path: '/admin/severity-rules', body: { severity: 'x', team_id: 'N2', escalate_to_team_id: 'N2', notify_webhook_urls: [], enabled: true } }))).statusCode).toBe(400);
    expect((await handler(adminEvent({ method: 'PUT', path: '/admin/severity-rules', body: { severity: 'x', team_id: 'N2', notify_webhook_urls: ['http://insecure'], enabled: true } }))).statusCode).toBe(400);
    db.seed(TABLES.severity, [rule({ severity: 'critical' })]);
    const list = parse(await handler(adminEvent({ path: '/admin/severity-rules' })));
    expect((list['items'] as { severity: string }[]).map((r) => r.severity)).toEqual(['critical', 'high']);
    expect(parse(await handler(adminEvent({ method: 'DELETE', path: '/admin/severity-rules', query: { severity: 'HIGH' } })))).toEqual({ ok: true });
    expect(db.items(TABLES.severity)).toHaveLength(1);
  });

  it('incidents: lists newest first with filters, and returns detail with audit timeline', async () => {
    seedIncident(db, incident({ incident_id: 'A', opened_at: '2026-09-24T10:00:00.000Z', status: 'closed' }), false);
    seedIncident(db, incident({ incident_id: 'B', opened_at: '2026-09-24T11:00:00.000Z', status: 'connected' }), false);
    seedIncident(db, incident({ incident_id: 'C', system_id: 'orders-api', opened_at: '2026-09-24T12:00:00.000Z', status: 'connected' }), false);
    db.seed(TABLES.audit, [
      { incident_id: 'B', event_key: '2026-09-24T11:00:01.000Z#2', ts: '2026-09-24T11:00:01.000Z', event_type: 'roster_resolved', actor: 'sfn', details: {} },
      { incident_id: 'B', event_key: '2026-09-24T11:00:00.000Z#1', ts: '2026-09-24T11:00:00.000Z', event_type: 'incident_opened', actor: 'system', details: {} },
    ]);
    const all = parse(await handler(adminEvent({ path: '/admin/incidents' })));
    expect((all['items'] as { incident_id: string }[]).map((i) => i.incident_id)).toEqual(['C', 'B', 'A']);
    const bySystem = parse(await handler(adminEvent({ path: '/admin/incidents', query: { system_id: 'payments-api', status: 'connected' } })));
    expect((bySystem['items'] as { incident_id: string }[]).map((i) => i.incident_id)).toEqual(['B']);
    const byStatus = parse(await handler(adminEvent({ path: '/admin/incidents', query: { status: 'connected', limit: '1' } })));
    expect((byStatus['items'] as { incident_id: string }[]).map((i) => i.incident_id)).toEqual(['C']);
    expect((await handler(adminEvent({ path: '/admin/incidents', query: { status: 'bogus' } }))).statusCode).toBe(400);

    const detail = parse(await handler(adminEvent({ path: '/admin/incidents/B' })));
    expect(detail['incident']).toMatchObject({ incident_id: 'B', status: 'connected' });
    expect((detail['events'] as { event_type: string }[]).map((e) => e.event_type)).toEqual(['incident_opened', 'roster_resolved']);
    expect((detail['incident'] as Record<string, unknown>)['pk']).toBeUndefined();
    expect((await handler(adminEvent({ path: '/admin/incidents/missing' }))).statusCode).toBe(404);
  });

  it('audit: defaults to ADMIN and returns newest first', async () => {
    db.seed(TABLES.audit, [
      { incident_id: 'ADMIN', event_key: '2026-09-24T10:00:00.000Z#1', ts: '', event_type: 'config_changed', actor: 'admin:a', details: {} },
      { incident_id: 'ADMIN', event_key: '2026-09-24T11:00:00.000Z#2', ts: '', event_type: 'config_changed', actor: 'admin:b', details: {} },
    ]);
    const res = parse(await handler(adminEvent({ path: '/admin/audit', query: { limit: '5' } })));
    expect((res['items'] as { actor: string }[]).map((e) => e.actor)).toEqual(['admin:b', 'admin:a']);
  });

  it('users: searches Graph and returns id/upn/name', async () => {
    mockFetch([tokenRoute, { method: 'GET', match: /\/users\?/, reply: () => json(200, { value: [{ id: 'u1', displayName: 'Ana', userPrincipalName: 'ana@x' }] }) }]);
    const res = parse(await handler(adminEvent({ path: '/admin/users', query: { search: 'ana' } })));
    expect(res).toEqual({ users: [{ id: 'u1', upn: 'ana@x', name: 'Ana' }] });
    expect(parse(await handler(adminEvent({ path: '/admin/users', query: { search: 'a' } })))).toEqual({ users: [] });
  });
});
