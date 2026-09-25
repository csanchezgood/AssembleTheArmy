# Panel de administración — AssembleTheArmy (`@ata/admin-web`)

SPA en Vite + React 18 + TypeScript + MSAL para administrar las guardias N2/N3, la
disponibilidad, las reglas de severidad y consultar incidentes/auditoría del sistema de
convocatoria automática. Habla con el `admin-api` descrito en `docs/ARCHITECTURE.md` §4.1.

## Comandos

```bash
# desde la raíz del repo (workspaces npm)
npm install
npm run dev -w @ata/admin-web         # http://localhost:5173
npm run typecheck -w @ata/admin-web
npm test -w @ata/admin-web
npm run build -w @ata/admin-web       # → packages/admin-web/dist/
```

## Modo simulado (sin Azure ni backend)

```bash
cp packages/admin-web/.env.example packages/admin-web/.env.local   # contiene VITE_MOCK_API=1
npm run dev -w @ata/admin-web
```

Con `VITE_MOCK_API=1`:

- no se inicia sesión con Entra ID: se usa una cuenta ficticia `admin@contoso.com`;
- todas las llamadas van a una API en memoria (`src/api/mock.ts`) con 20 sistemas de
  ejemplo, miembros N2/N3, ventanas de disponibilidad, reglas de severidad e incidentes
  con línea de tiempo de auditoría. Los cambios se pierden al recargar.

## Apuntar a una API real

El panel lee **en runtime** el archivo `/config.json` (en `public/config.json` durante el
desarrollo; en producción lo genera Terraform y lo sube al bucket de S3):

```json
{
  "tenantId": "<tenant id de Entra>",
  "clientId": "<client id del registro de la SPA>",
  "apiBaseUrl": "https://<api-id>.execute-api.<region>.amazonaws.com",
  "apiScope": "api://<client id del API>/access_as_user"
}
```

- `apiBaseUrl` sin barra final; el panel añade `/admin/...`.
- `apiScope` es el scope delegado que se pide a MSAL; el token resultante se envía como
  `Authorization: Bearer <token>` en cada llamada. Su `aud` debe coincidir con
  `admin_api_audience` del authorizer JWT de API Gateway.
- Quita `VITE_MOCK_API` (o ponlo a `0`) para usar MSAL y la API real.

El API debe permitir CORS desde el origen del panel (CloudFront) y desde
`http://localhost:5173` en desarrollo, con cabeceras `authorization, content-type` y
métodos `GET, PUT, POST, DELETE, OPTIONS`.

## Registro de la aplicación en Microsoft Entra ID

Se necesitan dos registros (o uno solo que haga ambos papeles):

### 1. API (`admin-api`)

1. *App registrations → New registration*, single tenant.
2. *Expose an API → Set Application ID URI* (`api://<client-id-del-api>`).
3. *Add a scope*: nombre `access_as_user`, consentimiento de administradores y usuarios,
   estado *Enabled*.
4. (Opcional) *Token configuration → Add groups claim* (Security groups) para que el
   Lambda pueda comprobar `ADMIN_GROUP_ID`. Si el usuario pertenece a muchos grupos, usa
   *App roles* y el claim `roles`.
5. Valores para Terraform: `admin_api_audience = <client id del API>` (o el Application
   ID URI, según cómo emita `aud` el tenant), `admin_api_scope = api://<client-id>/access_as_user`.

### 2. SPA (`admin-web`)

1. *App registrations → New registration*, single tenant.
2. *Authentication → Add a platform → Single-page application* (NO "Web") con URIs de
   redirección:
   - `https://<dominio-de-cloudfront>/`
   - `http://localhost:5173/`
   Deja desactivados los *implicit grant* (el panel usa PKCE por redirect).
3. *API permissions → Add a permission → My APIs → admin-api → access_as_user* y concede
   consentimiento de administrador para el tenant.
4. En el registro del API, *Expose an API → Authorized client applications* → añade el
   client id de la SPA con el scope `access_as_user` (evita el prompt de consentimiento).
5. Valor para Terraform: `admin_spa_client_id = <client id de la SPA>`.

Si se usa **un solo registro** para SPA y API, expón el scope en ese mismo registro y
usa `apiScope = api://<client-id>/access_as_user` con el mismo `clientId`.

## Estructura

```
src/
  config.ts            carga /config.json antes de montar la app
  auth/                MSAL (redirect, cache sessionStorage), AuthProvider, useAccessToken, RequireAuth
  api/types.ts         tipos del contrato §4.1 (réplica de backend/src/domain/types.ts)
  api/client.ts        cliente HTTP tipado (Bearer, JSON, errores { error })
  api/mock.ts          implementación en memoria con datos de ejemplo
  components/          shell, diálogos, selector de usuarios, badges, estados
  pages/               Incidentes, detalle, Sistemas y guardias, Disponibilidad, Reglas de severidad
  lib/                 fechas (ISO → hora local), etiquetas en español, validación de formularios
  test/                vitest + testing-library
```

## Notas

- Las fechas de la API son ISO 8601 UTC; la UI las muestra en la hora local del navegador
  y los `datetime-local` se convierten a UTC al guardar.
- El panel es responsive y respeta `prefers-color-scheme` (tema claro/oscuro).
- `AvailabilityItem` solo contiene `member_id`; para mostrar nombre y UPN en la tabla de
  disponibilidad el panel construye un directorio a partir de las guardias
  (`/admin/systems` + `/admin/roster` por sistema).
