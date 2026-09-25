import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AdminApi } from './types';
import { createHttpClient } from './client';
import { createMockApi } from './mock';
import { useAccessToken } from '../auth/AuthContext';
import { isMockMode, getConfig } from '../config';

const ApiContext = createContext<AdminApi | null>(null);

/** Provee una instancia de `AdminApi` (HTTP o simulada) al árbol de componentes. */
export function ApiProvider({ api, children }: { api?: AdminApi; children: ReactNode }) {
  const getToken = useAccessToken();
  const value = useMemo<AdminApi>(() => {
    if (api) return api;
    if (isMockMode()) return createMockApi();
    return createHttpClient({ baseUrl: getConfig().apiBaseUrl, getToken });
  }, [api, getToken]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): AdminApi {
  const api = useContext(ApiContext);
  if (!api) {
    throw new Error('useApi debe usarse dentro de <ApiProvider>');
  }
  return api;
}
