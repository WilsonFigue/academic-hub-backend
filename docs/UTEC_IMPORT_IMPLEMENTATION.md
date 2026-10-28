# Importación inicial UTEC (onboarding de desarrollo)

Objetivo: el operador entrega **solo** usuario y contraseña de Blackboard UTEC; Academic Hub verifica la identidad, importa los datos académicos a PostgreSQL y crea la cuenta propia de Academic Hub.

## Uso

1. API en marcha (`npm run dev`), con `NODE_ENV=development`, `HOST=127.0.0.1` y `DEV_OPERATOR_TOKEN` en `.env`.
2. En una terminal propia: `npm run dev:import`.
3. El comando pide usuario y contraseña (la contraseña no se muestra, no queda en historial ni en archivos).
4. Se abre Chromium; si UTEC pide MFA, el titular lo completa en esa ventana.
5. Al terminar se muestra el resumen y, si la cuenta es nueva, la **contraseña temporal de Academic Hub una sola vez**.

## Endpoints internos

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/internal/dev/utec/create-user` | Body exacto `{ "username", "password" }` (sin campos extra). 202 `{ operationId, status, poll }` |
| GET | `/internal/dev/utec/imports/:operationId` | Estado: `starting`, `authenticating`, `awaiting_mfa`, `extracting`, `persisting`, `completed`, `failed` |

### Seguridad

- Solo se registran con `NODE_ENV=development` + `DEV_OPERATOR_TOKEN` (≥32 caracteres; prohibido en producción) + servidor escuchando en loopback.
- Cada solicitud exige: conexión desde loopback (si no, 404), cabecera `x-dev-operator-token` (comparación en tiempo constante), y **ausencia de `Origin`** (un navegador no puede invocarlas: sin CSRF hacia localhost).
- Rate limit 5 por 10 min; una importación a la vez.
- El logger redacta `req.body`, contraseñas, cookies y tokens; estas rutas solo registran advertencias.
- Las credenciales UTEC viven en un cierre en memoria y se descartan al terminar el login. No se guardan en tablas, archivos, logs ni respuestas.
- La contraseña temporal de Academic Hub se genera con CSPRNG (20 caracteres), se guarda solo como hash Argon2id, se mantiene en memoria y **se entrega en la primera consulta del estado completado**; después se borra. Las operaciones expiran a los 30 min.
- Cookies de Blackboard solo del host `utecvirtual.blackboard.com`, solo en memoria (`MemoryOnlySession`), descartadas al final. Sin renovación SSO.

## Flujo

```text
dev:import → POST create-user → Playwright (Chromium visible)
  → login en el host UTEC (autorrelleno solo en utecvirtual.blackboard.com / *.utec.edu.sv)
  → espera /ultra (MFA manual si aparece; timeout 10 min)
  → cookies → blackboard-mcp Session.fromBrowserCookies → MemoryOnlySession → HttpClient (allowWrites:false)
  → Chromium se cierra
  → BlackboardGateway (solo GET) → normalización → PostgreSQL (transacción por materia)
```

`blackboard-mcp@0.1.2` (versión fijada) y Playwright se cargan **dinámicamente** solo en este flujo; la API pública no depende de ellos. El acceso a Blackboard está aislado tras `BlackboardGateway` (`src/modules/blackboard/gateway.ts`), cuyo transporte puede sustituirse por OAuth 3LO.

## Datos y endpoints utilizados

| Paso | Endpoint Blackboard | Destino |
|---|---|---|
| Identidad | `GET /learn/api/v1/users/me` (+ `locale` de `/learn/api/public/v1/users/{id}`) | `external_accounts` (perfil mínimo) |
| Inscripciones, materias, períodos | `GET /learn/api/v1/users/me/memberships` (curso y período expandidos) | `course_enrollments`, `courses`, `academic_terms` |
| Contenido | `…/contents/ROOT/children`, `…/INTERACTIVE/children`, `…/contents/{id}/children` (recorrido completo, límite configurable 5 000 nodos / profundidad 15, truncamiento registrado) | `course_content_items`, `enrollment_content_visibility` |
| Esquemas | `…/gradebook/schemas` | `grading_schemas` |
| Columnas | `…/gradebook/columns` | `gradebook_columns` (enlazadas por `contentId`) |
| Notas propias | `…/gradebook/grades?userId={self}` | `student_grades` (una fila por columna visible) |
| Intentos propios | `…/gradebook/attempts/{id}` (solo si `attempt.userId = self`) | `grade_attempts`; `is_submitted` derivado |
| Excepciones | `…/gradebook/memberships/{membershipId}/exceptions` | `due_date_exceptions` (raw) |
| Calendario | `…/courses/{id}/calendars/calendarItems?since&until` (ventana del período) | `calendar_items` enlazados a columnas |
| Pendientes | `/learn/api/v1/calendars/todo/studentItems` en ventanas de 14 días | `todo_observations`, vencimiento personal |
| Anuncios | `…/announcements` | `course_announcements`, `enrollment_announcements` |

Se excluyen organizaciones (`isOrganization`).

## Persistencia

- Una transacción para identidad (usuario + cuenta) y una por materia; ninguna abierta durante peticiones de red.
- Upserts idempotentes por ID externo dentro de su ámbito; `content_hash` evita reescrituras; el resumen distingue insertado / actualizado / sin cambios.
- Paginación protegida: se ignora un `nextPage` que no avanza o que pierde `since` (bug de `blackboard-mcp@0.1.2`).
- Cada recurso registra un `sync_run_step` con páginas, ítems, códigos HTTP, completitud y truncamiento. Un paso fallido no borra nada.
- Estado final: `succeeded` (todos completos), `partial` (algún paso incompleto), `failed` (error antes de terminar).

## Novedades entre importaciones

Cada upsert devuelve sus valores anteriores y nuevos (`RETURNING old/new`). La primera importación de una cuenta es la línea base; a partir de la segunda se registran en `entity_changes` las actividades nuevas, cambios de vencimiento, nombre o puntaje, calificaciones nuevas o modificadas, cambios de entrega, anuncios nuevos, materias y períodos nuevos. Las eliminaciones no se registran. El resumen de la importación incluye `sync.baseline` y `sync.changesRecorded`. Detalle de reglas en `DATABASE_ARCHITECTURE.md`.

## Usuario Academic Hub

- Si la identidad Blackboard ya está vinculada: se reutiliza el usuario, se actualiza el perfil y **no** se cambia la contraseña.
- Si no: se crea con correo institucional, `username` propio `nombre.apellido` (con sufijo si existe; independiente del usuario UTEC), contraseña temporal y `must_change_password = true`.
- Si el correo ya pertenece a otra cuenta sin ese vínculo: error `identity_conflict` (no se vincula por coincidencia de correo).
- Si Blackboard no devuelve correo: error `missing_email`.

## Errores

| Código | Significado |
|---|---|
| `login_timeout` | No se llegó a Ultra en 10 minutos (MFA no completado) |
| `browser_failed` | Chromium no pudo iniciar |
| `profile_unavailable` | No se pudo verificar la identidad |
| `memberships_unavailable` | No se pudieron leer las inscripciones |
| `blackboard_session_expired` | La sesión caducó durante la importación |
| `import_in_progress` | Ya hay una importación para esa cuenta |
| `identity_conflict` / `missing_email` | Ver arriba |
| `import_failed` | Error inesperado (detalle solo por nombre de error en el log) |

## Restricciones para producción

No existe en producción. La sincronización desatendida requiere una decisión institucional (OAuth 3LO u otra autorización explícita); no se almacenan contraseñas, cookies ni secretos TOTP.
