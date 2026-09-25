import { useCallback, useMemo, type ReactNode } from 'react';
import {
  InteractionRequiredAuthError,
  InteractionStatus,
  type AccountInfo,
  type PublicClientApplication,
} from '@azure/msal-browser';
import { MsalProvider, useMsal } from '@azure/msal-react';
import { AuthContext, type AuthAccount, type AuthContextValue } from './AuthContext';
import { tokenScopes } from './msal';
import type { AppConfig } from '../config';

interface AuthProviderProps {
  config: AppConfig;
  /** Instancia MSAL ya inicializada; `null` = modo simulado (sin login). */
  pca: PublicClientApplication | null;
  /** Cuenta ficticia usada en modo simulado. */
  mockAccount?: AuthAccount;
  children: ReactNode;
}

const DEFAULT_MOCK_ACCOUNT: AuthAccount = { name: 'Administrador (mock)', upn: 'admin@contoso.com' };

export function AuthProvider({ config, pca, mockAccount, children }: AuthProviderProps) {
  if (!pca) {
    return (
      <MockAuthProvider account={mockAccount ?? DEFAULT_MOCK_ACCOUNT}>{children}</MockAuthProvider>
    );
  }
  return (
    <MsalProvider instance={pca}>
      <MsalBridge config={config}>{children}</MsalBridge>
    </MsalProvider>
  );
}

function MockAuthProvider({ account, children }: { account: AuthAccount; children: ReactNode }) {
  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'mock',
      status: 'authenticated',
      account,
      getAccessToken: () => Promise.resolve('mock-access-token'),
      login: () => Promise.resolve(),
      logout: () => Promise.resolve(),
    }),
    [account],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const toAccount = (info: AccountInfo): AuthAccount => ({
  name: info.name ?? info.username,
  upn: info.username,
});

function MsalBridge({ config, children }: { config: AppConfig; children: ReactNode }) {
  const { instance, accounts, inProgress } = useMsal();
  const scopes = useMemo(() => tokenScopes(config), [config]);

  const activeAccount: AccountInfo | null = instance.getActiveAccount() ?? accounts[0] ?? null;

  const getAccessToken = useCallback(async (): Promise<string> => {
    const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
    if (!account) {
      throw new Error('No hay una sesión iniciada.');
    }
    try {
      const result = await instance.acquireTokenSilent({ scopes, account });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        await instance.acquireTokenRedirect({ scopes, account });
        throw new Error('Redirigiendo para renovar la sesión…');
      }
      throw err;
    }
  }, [instance, scopes]);

  const login = useCallback(async () => {
    await instance.loginRedirect({ scopes });
  }, [instance, scopes]);

  const logout = useCallback(async () => {
    await instance.logoutRedirect({ account: activeAccount ?? undefined });
  }, [instance, activeAccount]);

  const status: AuthContextValue['status'] =
    inProgress !== InteractionStatus.None ? 'loading' : activeAccount ? 'authenticated' : 'unauthenticated';

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'msal',
      status,
      account: activeAccount ? toAccount(activeAccount) : null,
      getAccessToken,
      login,
      logout,
    }),
    [status, activeAccount, getAccessToken, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
