import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMsalInstance } from './auth/msal';
import { isMockMode, loadConfig } from './config';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('No se encontró el elemento #root');
}
const root = createRoot(container);

async function bootstrap(): Promise<void> {
  const config = await loadConfig();
  const pca = isMockMode() ? null : await createMsalInstance(config);
  root.render(
    <StrictMode>
      <App config={config} pca={pca} />
    </StrictMode>,
  );
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  root.render(
    <main className="auth-screen">
      <div className="auth-card" role="alert">
        <h1>No se pudo iniciar el panel</h1>
        <p>{message}</p>
        <p className="muted">Comprueba que /config.json existe y es válido.</p>
      </div>
    </main>,
  );
});
