import { LogLevel, PublicClientApplication, type Configuration } from '@azure/msal-browser';
import type { AppConfig } from '../config';

export function buildMsalConfig(cfg: AppConfig): Configuration {
  return {
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: `${window.location.origin}/`,
      postLogoutRedirectUri: `${window.location.origin}/`,
      navigateToLoginRequestUrl: true,
    },
    cache: {
      cacheLocation: 'sessionStorage',
    },
    system: {
      loggerOptions: {
        logLevel: import.meta.env.DEV ? LogLevel.Info : LogLevel.Warning,
        piiLoggingEnabled: false,
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) console.error(message);
          else if (level === LogLevel.Warning) console.warn(message);
        },
      },
    },
  };
}

export async function createMsalInstance(cfg: AppConfig): Promise<PublicClientApplication> {
  const pca = new PublicClientApplication(buildMsalConfig(cfg));
  await pca.initialize();
  return pca;
}

/** Scopes pedidos al iniciar sesión y al adquirir el token del API. */
export const tokenScopes = (cfg: AppConfig): string[] => [cfg.apiScope];
