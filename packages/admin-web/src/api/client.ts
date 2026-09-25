import type {
  AdminApi,
  AuditEvent,
  AuditListParams,
  AvailabilityInput,
  AvailabilityItem,
  IncidentDetailResponse,
  IncidentListParams,
  IncidentListResponse,
  MeResponse,
  Member,
  RosterInput,
  RosterItem,
  SeverityRule,
  SeverityRuleInput,
  SystemSummary,
} from './types';

/** Error de la API: conserva el status HTTP y el mensaje `{ error }` del backend. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        params.set(key, String(value));
      }
    }
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

const defaultErrorMessage = (status: number): string => {
  switch (status) {
    case 401:
      return 'No autenticado. Vuelve a iniciar sesión.';
    case 403:
      return 'No tienes permisos para realizar esta acción.';
    case 404:
      return 'Recurso no encontrado.';
    default:
      return `Error del servidor (HTTP ${status}).`;
  }
};

async function extractError(res: Response): Promise<ApiError> {
  let message = defaultErrorMessage(res.status);
  try {
    const text = await res.text();
    if (text) {
      const body: unknown = JSON.parse(text);
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const err = (body as { error: unknown }).error;
        if (typeof err === 'string' && err.trim()) {
          message = err;
        }
      }
    }
  } catch {
    /* cuerpo no JSON: se conserva el mensaje por defecto */
  }
  return new ApiError(res.status, message);
}

export function createHttpClient(options: HttpClientOptions): AdminApi {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));

  async function request<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    query?: Query,
    body?: unknown,
  ): Promise<T> {
    const token = await options.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetchFn(buildUrl(options.baseUrl, path, query), init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError(0, `No se pudo conectar con la API (${reason}).`);
    }
    if (!res.ok) {
      throw await extractError(res);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  return {
    async getMe() {
      return request<MeResponse>('GET', '/admin/me');
    },
    async listSystems() {
      const r = await request<{ systems: SystemSummary[] }>('GET', '/admin/systems');
      return r.systems;
    },
    async listRoster(systemId) {
      const r = await request<{ items: RosterItem[] }>('GET', '/admin/roster', { system_id: systemId });
      return r.items;
    },
    async putRoster(input: RosterInput) {
      const r = await request<{ item: RosterItem }>('PUT', '/admin/roster', undefined, input);
      return r.item;
    },
    async deleteRoster(systemId, rosterKey) {
      await request<{ ok: true }>('DELETE', '/admin/roster', { system_id: systemId, roster_key: rosterKey });
    },
    async listAvailability(memberId) {
      const r = await request<{ items: AvailabilityItem[] }>('GET', '/admin/availability', {
        member_id: memberId,
      });
      return r.items;
    },
    async putAvailability(input: AvailabilityInput) {
      const r = await request<{ item: AvailabilityItem }>('PUT', '/admin/availability', undefined, input);
      return r.item;
    },
    async deleteAvailability(memberId, validFrom) {
      await request<{ ok: true }>('DELETE', '/admin/availability', {
        member_id: memberId,
        valid_from: validFrom,
      });
    },
    async listSeverityRules() {
      const r = await request<{ items: SeverityRule[] }>('GET', '/admin/severity-rules');
      return r.items;
    },
    async putSeverityRule(input: SeverityRuleInput) {
      const r = await request<{ item: SeverityRule }>('PUT', '/admin/severity-rules', undefined, input);
      return r.item;
    },
    async deleteSeverityRule(severity) {
      await request<{ ok: true }>('DELETE', '/admin/severity-rules', { severity });
    },
    async listIncidents(params: IncidentListParams = {}) {
      return request<IncidentListResponse>('GET', '/admin/incidents', {
        system_id: params.system_id,
        status: params.status,
        limit: params.limit ?? 50,
        cursor: params.cursor,
      });
    },
    async getIncident(incidentId) {
      return request<IncidentDetailResponse>('GET', `/admin/incidents/${encodeURIComponent(incidentId)}`);
    },
    async searchUsers(search) {
      const r = await request<{ users: Member[] }>('GET', '/admin/users', { search });
      return r.users;
    },
    async listAudit(params: AuditListParams = {}) {
      const r = await request<{ items: AuditEvent[] }>('GET', '/admin/audit', {
        incident_id: params.incident_id ?? 'ADMIN',
        limit: params.limit,
      });
      return r.items;
    },
  };
}
