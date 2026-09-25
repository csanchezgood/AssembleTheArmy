import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from './helpers';

describe('IncidentsPage (API simulada)', () => {
  it('lista los incidentes de ejemplo con estado, sistema y contadores', async () => {
    renderApp('/incidentes');

    expect(await screen.findByText('Payments API - error rate')).toBeTruthy();
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1); // sin cabecera
    expect(rows.length).toBe(5);

    // Orden: más recientes primero.
    const first = rows[0];
    expect(first?.textContent).toContain('auth-gateway');
    expect(first?.textContent).toContain('Convocando');

    expect(within(table).getByText('Conectado')).toBeTruthy();
    expect(within(table).getAllByText('Cerrado', { selector: '.badge' }).length).toBe(2);
    expect(within(table).getByText('Sin respuesta')).toBeTruthy();
  });

  it('la raíz redirige a /incidentes', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Incidentes' })).toBeTruthy();
  });

  it('el detalle muestra la línea de tiempo traducida y los participantes', async () => {
    renderApp('/incidentes/01J8QB7H2D4F6G8J0K1L3M5N7P');

    expect(await screen.findByRole('heading', { level: 1, name: 'Checkout Web - latency p95' })).toBeTruthy();
    expect(screen.getByText('Backup sustituido')).toBeTruthy();
    expect(screen.getByText('Convocatoria conectada')).toBeTruthy();
    expect(screen.getAllByText('Beto Ramírez').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Carla Méndez').length).toBeGreaterThan(0);
  });
});
