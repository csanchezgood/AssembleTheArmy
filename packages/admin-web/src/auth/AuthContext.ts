import { createContext, useContext } from 'react';

export interface AuthAccount {
  name: string;
  upn: string;
}

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthContextValue {
  mode: 'msal' | 'mock';
  status: AuthStatus;
  account: AuthAccount | null;
  /** Token de acceso para `apiScope` (silencioso, con fallback interactivo por redirect). */
  getAccessToken: () => Promise<string>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  }
  return ctx;
}

/** Devuelve la función que obtiene el token de acceso para el API. */
export function useAccessToken(): () => Promise<string> {
  return useAuth().getAccessToken;
}
