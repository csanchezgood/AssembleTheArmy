import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { createMockApi } from '../api/mock';
import { renderApp } from './helpers';

describe('SystemsPage (API simulada)', () => {
  it('lista los 20 sistemas y agrupa la guardia por equipo en orden de prioridad', async () => {
    const api = createMockApi({ latencyMs: 0 });
    const expected = await api.listRoster('payments-api');
    renderApp('/sistemas/payments-api', api);

    const n2 = await screen.findByRole('region', { name: /Equipo N2/ });
    const n3 = await screen.findByRole('region', { name: /Equipo N3/ });

    const n2Names = within(n2)
      .getAllByRole('listitem')
      .map((li) => within(li).getByText(/.+/, { selector: '.member-name' }).textContent);
    const n3Names = within(n3)
      .getAllByRole('listitem')
      .map((li) => within(li).getByText(/.+/, { selector: '.member-name' }).textContent);

    const expectedN2 = expected
      .filter((r) => r.team_id === 'N2')
      .sort((a, b) => a.priority_order - b.priority_order)
      .map((r) => r.member_name);
    const expectedN3 = expected
      .filter((r) => r.team_id === 'N3')
      .sort((a, b) => a.priority_order - b.priority_order)
      .map((r) => r.member_name);

    expect(n2Names).toEqual(expectedN2);
    expect(n3Names).toEqual(expectedN3);
    expect(within(n2).getByRole('link', { name: /Abrir sala del equipo N2/ })).toBeTruthy();

    const nav = screen.getByRole('complementary', { name: 'Sistemas' });
    expect(within(nav).getAllByRole('link').length).toBe(20);
  });

  it('muestra el estado vacío para un sistema nuevo', async () => {
    renderApp('/sistemas/nuevo-sistema');
    expect(await screen.findByText('Sin miembros en N2.')).toBeTruthy();
    expect(screen.getByText('Sin miembros en N3.')).toBeTruthy();
  });
});
