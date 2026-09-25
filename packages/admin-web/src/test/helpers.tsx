import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ApiProvider } from '../api/ApiContext';
import { createMockApi } from '../api/mock';
import type { AdminApi } from '../api/types';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { AppRoutes } from '../App';

export const testAuth: AuthContextValue = {
  mode: 'mock',
  status: 'authenticated',
  account: { name: 'Prueba', upn: 'prueba@contoso.com' },
  getAccessToken: () => Promise.resolve('test-token'),
  login: () => Promise.resolve(),
  logout: () => Promise.resolve(),
};

export function renderWithProviders(ui: ReactNode, opts: { route?: string; api?: AdminApi } = {}) {
  const api = opts.api ?? createMockApi({ latencyMs: 0 });
  const result = render(
    <AuthContext.Provider value={testAuth}>
      <ApiProvider api={api}>
        <MemoryRouter initialEntries={[opts.route ?? '/']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
      </ApiProvider>
    </AuthContext.Provider>,
  );
  return { ...result, api };
}

export function renderApp(route: string, api?: AdminApi) {
  return renderWithProviders(<AppRoutes />, { route, ...(api ? { api } : {}) });
}
