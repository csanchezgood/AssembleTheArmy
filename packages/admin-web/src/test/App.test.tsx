import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../App';
import { createMockApi } from '../api/mock';
import { setConfigForTests } from '../config';

describe('App en modo simulado', () => {
  it('omite el login de MSAL y muestra la cuenta ficticia', async () => {
    setConfigForTests({
      tenantId: 'common',
      clientId: '00000000-0000-0000-0000-000000000000',
      apiBaseUrl: 'http://localhost:3000',
      apiScope: 'api://00000000-0000-0000-0000-000000000000/access_as_user',
    });
    window.history.pushState({}, '', '/severidad');
    render(
      <App
        config={{
          tenantId: 'common',
          clientId: '00000000-0000-0000-0000-000000000000',
          apiBaseUrl: 'http://localhost:3000',
          apiScope: 'api://00000000-0000-0000-0000-000000000000/access_as_user',
        }}
        pca={null}
        api={createMockApi({ latencyMs: 0 })}
      />,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Reglas de severidad' })).toBeTruthy();
    expect(await screen.findByText('admin@contoso.com')).toBeTruthy();
    expect(screen.getByText('modo simulado')).toBeTruthy();
    expect(screen.queryByText('Cerrar sesión')).toBeNull();
    expect(await screen.findByRole('form', { name: 'Regla critical' })).toBeTruthy();
  });
});
