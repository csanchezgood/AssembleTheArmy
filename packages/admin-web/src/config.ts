/**
 * Configuración en runtime del panel. Se lee de `/config.json` (lo genera
 * Terraform y lo sube a S3) antes de montar la aplicación.
 * Forma esperada (ARCHITECTURE.md §5): { tenantId, clientId, apiBaseUrl, apiScope }.
 */
export interface AppConfig {
  tenantId: string;
  clientId: string;
  apiBaseUrl: string;
  apiScope: string;
}

export const isMockMode = (): boolean => import.meta.env.VITE_MOCK_API === '1';

const DEFAULT_MOCK_CONFIG: AppConfig = {
  tenantId: 'common',
  clientId: '00000000-0000-0000-0000-000000000000',
  apiBaseUrl: 'http://localhost:3000',
  apiScope: 'api://00000000-0000-0000-0000-000000000000/access_as_user',
};

let current: AppConfig | null = null;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function parseConfig(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.json no es un objeto JSON');
  }
  const obj = raw as Record<string, unknown>;
  const keys = ['tenantId', 'clientId', 'apiBaseUrl', 'apiScope'] as const;
  for (const key of keys) {
    if (!isString(obj[key])) {
      throw new Error(`config.json: falta la propiedad "${key}"`);
    }
  }
  return {
    tenantId: obj.tenantId as string,
    clientId: obj.clientId as string,
    apiBaseUrl: (obj.apiBaseUrl as string).replace(/\/+$/, ''),
    apiScope: obj.apiScope as string,
  };
}

export async function loadConfig(fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  try {
    const res = await fetchFn('/config.json', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`No se pudo cargar /config.json (HTTP ${res.status})`);
    }
    current = parseConfig(await res.json());
  } catch (err) {
    if (isMockMode()) {
      current = DEFAULT_MOCK_CONFIG;
    } else {
      throw err;
    }
  }
  return current;
}

export function getConfig(): AppConfig {
  if (!current) {
    throw new Error('La configuración aún no se ha cargado');
  }
  return current;
}

/** Solo para pruebas. */
export function setConfigForTests(cfg: AppConfig | null): void {
  current = cfg;
}
