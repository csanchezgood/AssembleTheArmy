import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';

/** Fuerza el inicio de sesión (redirect) antes de mostrar el contenido. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'unauthenticated') {
      login().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }
  }, [status, login]);

  if (status === 'authenticated') {
    return <>{children}</>;
  }

  return (
    <main className="auth-screen" aria-live="polite">
      <div className="auth-card">
        <h1>AssembleTheArmy</h1>
        {error ? (
          <>
            <p className="form-error" role="alert">
              No se pudo iniciar sesión: {error}
            </p>
            <button type="button" className="btn btn-primary" onClick={() => void login()}>
              Reintentar inicio de sesión
            </button>
          </>
        ) : (
          <p>{status === 'loading' ? 'Comprobando la sesión…' : 'Redirigiendo al inicio de sesión de Microsoft…'}</p>
        )}
      </div>
    </main>
  );
}
