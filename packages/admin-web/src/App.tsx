import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { PublicClientApplication } from '@azure/msal-browser';
import { ApiProvider } from './api/ApiContext';
import type { AdminApi } from './api/types';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import type { AppConfig } from './config';
import { AvailabilityPage } from './pages/AvailabilityPage';
import { IncidentDetailPage } from './pages/IncidentDetailPage';
import { IncidentsPage } from './pages/IncidentsPage';
import { SeverityRulesPage } from './pages/SeverityRulesPage';
import { SystemsPage } from './pages/SystemsPage';

/** Rutas del panel (sin router: se envuelven en BrowserRouter o MemoryRouter en pruebas). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/incidentes" replace />} />
        <Route path="/incidentes" element={<IncidentsPage />} />
        <Route path="/incidentes/:incidentId" element={<IncidentDetailPage />} />
        <Route path="/sistemas" element={<SystemsPage />} />
        <Route path="/sistemas/:systemId" element={<SystemsPage />} />
        <Route path="/disponibilidad" element={<AvailabilityPage />} />
        <Route path="/severidad" element={<SeverityRulesPage />} />
        <Route path="*" element={<Navigate to="/incidentes" replace />} />
      </Route>
    </Routes>
  );
}

interface AppProps {
  config: AppConfig;
  /** `null` = modo simulado sin MSAL. */
  pca: PublicClientApplication | null;
  /** API a usar (pruebas); por defecto se elige HTTP o simulada según el entorno. */
  api?: AdminApi;
}

export function App({ config, pca, api }: AppProps) {
  return (
    <AuthProvider config={config} pca={pca}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <RequireAuth>
          <ApiProvider api={api}>
            <AppRoutes />
          </ApiProvider>
        </RequireAuth>
      </BrowserRouter>
    </AuthProvider>
  );
}
