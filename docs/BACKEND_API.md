# API REST de Academic Hub

Base: `http://127.0.0.1:4000` (desarrollo). Prefijo de la API: `/api/v1`. OpenAPI generado: `GET /openapi.json`.

## Convenciones

- JSON; IDs **internos** (UUID). Nunca se aceptan `userId` del cliente: la propiedad se resuelve desde la sesión.
- **Sesión**: cookie `ah_session` (HttpOnly, token opaco; en la BD solo su SHA-256). TTL `SESSION_TTL_DAYS`.
- **CSRF**: cookie legible `ah_csrf`; los métodos no seguros deben enviar su valor en `x-csrf-token` (ligado a la sesión). Además se rechaza un `Origin` distinto de `FRONTEND_ORIGIN`.
- **Cookies**: en desarrollo el frontend usa el proxy de Vite (mismo origen) → `SameSite=Lax`. Si frontend y API quedan en sitios distintos: `COOKIE_SAME_SITE=none` + `COOKIE_SECURE=true` (validado al arrancar). `COOKIE_SECURE` es obligatorio en producción.
- **Rate limit**: global 300/min; credenciales 10/min por **IP + identificador**.
- **Contraseña temporal**: con `mustChangePassword=true` toda ruta responde `403 password_change_required`, salvo sesión, logout y cambio de contraseña.
- **Errores**: `{ "error": { "code": "…", "message": "…" } }`. Recursos ajenos responden **404** (no se revela su existencia).

| Código | Cuándo |
|---|---|
| 400 `validation_failed` / `weak_password` / `invalid_current_password` | cuerpo inválido |
| 401 `unauthorized` / `invalid_credentials` | sin sesión / credenciales incorrectas (mismo mensaje si el usuario no existe) |
| 403 `csrf_invalid` / `origin_not_allowed` / `password_change_required` | — |
| 404 `not_found` | inexistente o ajeno |
| 409 `email_taken` | registro duplicado |
| 429 `rate_limited` | — |
| 503 `database_unavailable` | BD caída (sin detalles internos) |

## Salud

| Método | Ruta | Auth | Respuesta |
|---|---|---|---|
| GET | `/health` | No | `{ "status": "ok" }` |
| GET | `/health/db` | No | `{ "status": "ok", "database": "reachable", "latencyMs": 600 }` o 503 sin detalles |

## Autenticación

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password (≥12), displayName? }` | 201 `{ user, csrfToken, expiresAt }` + cookies |
| POST | `/auth/login` | `{ identifier (correo o usuario), password }` | 200 `{ user, csrfToken, expiresAt }` + cookies |
| POST | `/auth/logout` | — | 204, revoca la sesión |
| POST | `/auth/logout-all` | — | `{ revokedSessions }` |
| GET | `/auth/session` | — | `{ user, expiresAt }` |
| POST | `/auth/password` | `{ currentPassword, newPassword }` | 204; revoca las demás sesiones |

Ejemplo:

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "identifier": "nombre.apellido", "password": "••••••••••••" }
```

```json
{ "user": { "id": "0198…", "email": "…", "username": "nombre.apellido", "displayName": "…", "mustChangePassword": true, "emailVerified": false, "createdAt": "…" },
  "csrfToken": "…", "expiresAt": "2026-11-04T07:00:00.000Z" }
```

## Usuario, instituciones y cuentas

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/me` | `{ user, universityAccounts[] }` |
| PATCH | `/me` | body `{ displayName }` → `{ user }` |
| GET | `/institutions` | `{ institutions[] }` |
| GET | `/me/university-accounts` | `{ universityAccounts[] }` (sin secretos) |
| GET | `/me/university-accounts/:id` | `{ universityAccount }` o 404 |

## Datos académicos

| Método | Ruta | Query | Respuesta |
|---|---|---|---|
| GET | `/terms` | — | períodos derivados de las inscripciones, con `isCurrentByDate`, `isPreferredCurrent`, `courseCount` |
| GET | `/terms/current` | — | `{ terms[], ambiguous }` (varios candidatos se devuelven todos) |
| GET | `/terms/:id/courses` | — | materias de ese período |
| GET | `/courses` | `termId?` | materias con período, inscripción, `activityCount`, `nextDueAt` |
| GET | `/courses/:id` | — | detalle + enlace a Blackboard |
| GET | `/courses/:id/content` | — | nodos visibles **para tu inscripción** (un padre no visible no se revela) |
| GET | `/courses/:id/grades` | — | columnas visibles con estado personal (incluye calculadas) |
| GET | `/activities` | `courseId?`, `from?`, `to?`, `status?` (`pending`/`submitted`/`graded`) | actividades evaluables (sin columnas calculadas) |
| GET | `/activities/:id` | — | `{ activity, attempts[] }` |
| GET | `/calendar` | `from?`, `to?` | vencimientos + eventos independientes; los `GradableItem` enlazados no se duplican |
| GET | `/dashboard` | — | cuentas, períodos, resumen, materias, próximas, calificaciones, última sincronización |
| GET | `/sync-runs` | — | historial de sincronizaciones propias |
| GET | `/sync-runs/:id` | — | ejecución + pasos (completitud por recurso) |
| GET | `/grades` | `courseId?`, `termId?` | libro de calificaciones propio de todas las materias; incluye columnas calculadas con `isCalculated: true` |
| GET | `/changes` | `limit?` (≤100), `before?` (cursor), `courseId?` | novedades: personales de tus cuentas + compartidas de tus materias detectadas después de tu inscripción. `{ changes[], nextCursor }` |
| GET | `/courses/:id/evaluation-cycles` | — | `{ cycles[], items[] }` de tu inscripción (404 si no es tuya) |
| PUT | `/courses/:id/evaluation-cycles` | body `{ activeNumber, cycles[{ number, label, weightPercent, items[{ activityId, weightWithinCycle }] }] }` | reemplazo idempotente. 400 `duplicate_cycle`, `invalid_active_cycle`, `activity_in_multiple_cycles`, `weights_exceed_100`, `invalid_activity` (actividad ajena o de otra materia) |

Campos añadidos (compatibles) en actividades/notas: `feedbackText`, `lmsUrl`, `termId`, `termName`, `attemptCount`, `submittedAt` (recibo de entrega), `gradedAt`, y en `content`: `description` (solo si difiere del título) y `externalUrl`. `/activities` acepta además `termId`. `/calendar` devuelve `submissionStatus`, `isAutoZero`, `kind`, `categoryKey`, `score`, `pointsPossible`. `/dashboard` añade `recentChanges` (5) y `weekAhead` (próximos 7 días).

`categoryKey` es la clave original de Blackboard (`Test.name`, `Homework.name`…); la traducción a texto legible la hace el frontend.

`activity.id` es el ID interno de la fila personal (`student_grades.id`), nunca un ID compartido.

## Rutas internas de desarrollo

Ver `UTEC_IMPORT_IMPLEMENTATION.md`. `POST /internal/dev/utec/create-user` y `GET /internal/dev/utec/imports/:operationId` existen **solo** con `NODE_ENV=development`, `DEV_OPERATOR_TOKEN` y `HOST` en loopback; no forman parte de `/api/v1` ni del OpenAPI.

## Pendiente

- `POST /me/university-accounts` (vinculación desde la app) y `POST …/sync`: dependen de la decisión de autenticación con UTEC (3LO).
- Verificación de correo / recuperación de contraseña: tabla preparada, sin proveedor de correo.
- Sugerencias automáticas de ciclos a partir de fórmulas de Blackboard (hoy solo referencia en el frontend).
