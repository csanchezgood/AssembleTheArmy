import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../api/ApiContext';
import { useAsync } from '../lib/useAsync';

const NAV = [
  { to: '/incidentes', label: 'Incidentes' },
  { to: '/sistemas', label: 'Sistemas y guardias' },
  { to: '/disponibilidad', label: 'Disponibilidad' },
  { to: '/severidad', label: 'Reglas de severidad' },
];

export function Layout() {
  const { account, logout, mode } = useAuth();
  const api = useApi();
  const me = useAsync(() => api.getMe(), [api]);
  const [menuOpen, setMenuOpen] = useState(false);

  const displayName = me.data?.name ?? account?.name ?? '';
  const upn = me.data?.upn ?? account?.upn ?? '';

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Saltar al contenido
      </a>
      <header className="app-header">
        <div className="app-brand">
          <span className="app-logo" aria-hidden="true">
            ⚔
          </span>
          <span className="app-title">AssembleTheArmy</span>
          {mode === 'mock' && <span className="badge badge-mock">modo simulado</span>}
        </div>
        <button
          type="button"
          className="btn btn-icon nav-toggle"
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          aria-label="Abrir menú"
          onClick={() => setMenuOpen((o) => !o)}
        >
          ☰
        </button>
        <nav id="main-nav" className={`app-nav${menuOpen ? ' open' : ''}`} aria-label="Principal">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-user">
          <span className="app-user-name">{displayName}</span>
          <span className="app-user-upn">{upn}</span>
          {mode === 'msal' && (
            <button type="button" className="btn btn-link" onClick={() => void logout()}>
              Cerrar sesión
            </button>
          )}
        </div>
      </header>
      {me.data && !me.data.is_admin && (
        <div className="banner banner-warn" role="alert">
          Tu cuenta no pertenece al grupo de administradores: las operaciones de escritura serán rechazadas.
        </div>
      )}
      <main id="main" className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
