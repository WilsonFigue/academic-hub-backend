`# Importación inicial UTEC (onboarding de desarrollo)
`
`Objetivo: el operador entrega **solo** usuario y contraseña de Blackboard UTEC; Academic Hub verifica la identidad, importa los datos académicos a PostgreSQL y crea la cuenta propia de Academic Hub.
`
`## Uso
`
`1. API en marcha (`npm run dev`), con `NODE_ENV=development`, `HOST=127.0.0.1` y `DEV_OPERATOR_TOKEN` en `.env`.
`2. En una terminal propia: `npm run dev:import`.
`3. El comando pide usuario y contraseña (la contraseña no se muestra, no queda en historial ni en archivos).
`4. Se abre Chromium; si UTEC pide MFA, el titular lo completa en esa ventana.
`5. Al terminar se muestra el resumen y, si la cuenta es nueva, la **contraseña temporal de Academic Hub una sola vez**.
`
`## Endpoints internos
`
`| Método | Ruta | Descripción |
`|---|---|---|
`| POST | `/internal/dev/utec/create-user` | Body exacto `{ "username", "password" }` (sin campos extra). 202 `{ operationId, status, poll }` |
`| GET | `/internal/dev/utec/imports/:operationId` | Estado: `starting`, `authenticating`, `awaiting_mfa`, `extracting`, `persisting`, `completed`, `failed` |
`
`### Seguridad
`
`- Solo se registran con `NODE_ENV=development` + `DEV_OPERATOR_TOKEN` (≥32 caracteres; prohibido en producción) + servidor escuchando en loopback.
`- Cada solicitud exige: conexión desde loopback (si no, 404), cabecera `x-dev-operator-token` (comparación en tiempo constante), y **ausencia de `Origin`** (un navegador no puede invocarlas: sin CSRF hacia localhost).
`- Rate limit 5 por 10 min; una importación a la vez.
`- El logger redacta `req.body`, contraseñas, cookies y tokens; estas rutas solo registran advertencias.
`- Las credenciales UTEC viven en un cierre en memoria y se descartan al terminar el login. No se guardan en tablas, archivos, logs ni respuestas.
`- La contraseña temporal de Academic Hub se genera con CSPRNG (20 caracteres), se guarda solo como hash Argon2id, se mantiene en memoria y **se entrega en la primera consulta del estado completado**; después se borra. Las operaciones expiran a los 30 min.
`- Cookies de Blackboard solo del host `utecvirtual.blackboard.com`, solo en memoria (`MemoryOnlySession`), descartadas al final. Sin renovación SSO.
`
`## Flujo
`
````text
`dev:import → POST create-user → Playwright (Chromium visible)
`  → login en el host UTEC (autorrelleno solo en utecvirtual.blackboard.com / *.utec.edu.sv)
`  → espera /ultra (MFA manual si aparece; timeout 10 min)
`  → cookies → blackboard-mcp Session.fromBrowserCookies → MemoryOnlySession → HttpClient (allowWrites:false)
`  → Chromium se cierra
`  → BlackboardGateway (solo GET) → normalización → PostgreSQL (transacción por materia)
````
`
``blackboard-mcp@0.1.2` (versión fijada) y Playwright se cargan **dinámicamente** solo en este flujo; la API pública no depende de ellos. El acceso a Blackboard está aislado tras `BlackboardGateway` (`src/modules/blackboard/gateway.ts`), cuyo transporte puede sustituirse por OAuth 3LO.
`
`## Datos y endpoints utilizados
`
`| Paso | Endpoint Blackboard | Destino |
`|---|---|---|
`| Identidad | `GET /learn/api/v1/users/me` (+ `locale` de `/learn/api/public/v1/users/{id}`) | `external_accounts` (perfil mínimo) |
`| Inscripciones, materias, períodos | `GET /learn/api/v1/users/me/memberships` (curso y período expandidos) | `course_enrollments`, `courses`, `academic_terms` |
`| Contenido | `…/contents/ROOT/children`, `…/INTERACTIVE/children`, `…/contents/{id}/children` (recorrido completo, límite configurable 5 000 nodos / profundidad 15, truncamiento registrado) | `course_content_items`, `enrollment_content_visibility` |
`| Esquemas | `…/gradebook/schemas` | `grading_schemas` |
`| Columnas | `…/gradebook/columns` | `gradebook_columns` (enlazadas por `contentId`) |
`| Notas propias | `…/gradebook/grades?userId={self}` | `student_grades` (una fila por columna visible) |
`| Intentos propios | `…/gradebook/attempts/{id}` (solo si `attempt.userId = self`) | `grade_attempts`; `is_submitted` derivado |
`| Excepciones | `…/gradebook/memberships/{membershipId}/exceptions` | `due_date_exceptions` (raw) |
`| Calendario | `…/courses/{id}/calendars/calendarItems?since&until` (ventana del período) | `calendar_items` enlazados a columnas |
`| Pendientes | `/learn/api/v1/calendars/todo/studentItems` en ventanas de 14 días | `todo_observations`, vencimiento personal |
`| Anuncios | `…/announcements` | `course_announcements`, `enrollment_announcements` |
`
`Se excluyen organizaciones (`isOrganization`).
`
`## Persistencia
`
`- Una transacción para identidad (usuario + cuenta) y una por materia; ninguna abierta durante peticiones de red.
`- Upserts idempotentes por ID externo dentro de su ámbito; `content_hash` evita reescrituras; el resumen distingue insertado / actualizado / sin cambios.
`- Paginación protegida: se ignora un `nextPage` que no avanza o que pierde `since` (bug de `blackboard-mcp@0.1.2`).
`- Cada recurso registra un `sync_run_step` con páginas, ítems, códigos HTTP, completitud y truncamiento. Un paso fallido no borra nada.
`- Estado final: `succeeded` (todos completos), `partial` (algún paso incompleto), `failed` (error antes de terminar).
`
`## Novedades entre importaciones
`
`Cada upsert devuelve sus valores anteriores y nuevos (`RETURNING old/new`). La primera importación de una cuenta es la línea base; a partir de la segunda se registran en `entity_changes` las actividades nuevas, cambios de vencimiento, nombre o puntaje, calificaciones nuevas o modificadas, cambios de entrega, anuncios nuevos, materias y períodos nuevos. Las eliminaciones no se registran. El resumen de la importación incluye `sync.baseline` y `sync.changesRecorded`. Detalle de reglas en `DATABASE_ARCHITECTURE.md`.
`
`## Usuario Academic Hub
`
`- Si la identidad Blackboard ya está vinculada: se reutiliza el usuario, se actualiza el perfil y **no** se cambia la contraseña.
`- Si no: se crea con correo institucional, `username` propio `nombre.apellido` (con sufijo si existe; independiente del usuario UTEC), contraseña temporal y `must_change_password = true`.
`- Si el correo ya pertenece a otra cuenta sin ese vínculo: error `identity_conflict` (no se vincula por coincidencia de correo).
`- Si Blackboard no devuelve correo: error `missing_email`.
`
`## Errores
`
`| Código | Significado |
`|---|---|
`| `login_timeout` | No se llegó a Ultra en 10 minutos (MFA no completado) |
`| `browser_failed` | Chromium no pudo iniciar |
`| `profile_unavailable` | No se pudo verificar la identidad |
`| `memberships_unavailable` | No se pudieron leer las inscripciones |
`| `blackboard_session_expired` | La sesión caducó durante la importación |
`| `import_in_progress` | Ya hay una importación para esa cuenta |
`| `identity_conflict` / `missing_email` | Ver arriba |
`| `import_failed` | Error inesperado (detalle solo por nombre de error en el log) |
`
`## Restricciones para producción
`
`No existe en producción. La sincronización desatendida requiere una decisión institucional (OAuth 3LO u otra autorización explícita); no se almacenan contraseñas, cookies ni secretos TOTP.
`
`## Actualizaciones de datos: completa y diaria
`
`Además de la importación inicial, hay dos operaciones para **cuentas ya vinculadas**. Ambas usan el mismo mecanismo y las mismas protecciones que `create-user` (loopback, token de operador, sin `Origin`, una a la vez, credenciales solo en memoria, MFA manual) y **no crean cuentas**: una identidad Blackboard sin cuenta responde `account_not_found`.
`
`| Método | Ruta | Qué hace | Límite |
`|---|---|---|---|
`| POST | `/internal/dev/utec/refresh/full` | Actualización completa: inscripciones (incluidas las cerradas), árbol de contenido, esquemas, columnas, notas, intentos, excepciones, calendario, anuncios y pendientes; además guarda el **historial de materias** | 10 / 10 min |
`| POST | `/internal/dev/utec/refresh/daily` | Actualización ligera de lo que cambia a diario: columnas, notas, intentos, excepciones, calendario, anuncios y pendientes de las materias **en curso**. No relee contenido ni esquemas (conserva los enlaces columna → contenido ya guardados) y omite materias cerradas | 30 / 10 min |
`
`Mismo cuerpo exacto `{ "username", "password" }` y mismo estado en `GET /internal/dev/utec/imports/:operationId`. La respuesta completada incluye `mode`, `history` (solo en la completa) y `skippedClosed` (solo en la diaria). Cada ejecución queda en `sync_runs` con `trigger` = `dev_refresh_full` o `dev_refresh_daily`, y registra novedades igual que la importación inicial.
`
`Desde terminal: `npm run refresh:full` o `npm run refresh:daily` piden usuario y contraseña (oculta) y repiten para cada usuario que se quiera actualizar.
`
`### Historial de materias (`enrollment_outcomes`, migración 0013)
`
`Una fila por inscripción, calculada en la actualización completa solo con lo que Blackboard muestra:
`
`- **Estado**: `closed` si Blackboard marca la materia cerrada (`course_closed`), si terminó el período (`term_ended`) o si terminó la materia (`course_ended`); si no, `in_progress`. `closed_at` es la fecha de fin observada.
`- **Calificación general**: la columna que Blackboard marca como calificación general (`externalGrade`); se guardan su nombre, nota, puntos posibles y `displayGrade`. Si ninguna columna la marca, queda vacía.
`- **Resultado** (`passed` / `failed` / `unknown`): **solo** para materias cerradas con calificación general, y **solo** si el operador define `PASSING_GRADE_PCT` (nota mínima en %, 0–100). Se guarda con `outcome_basis = configured_threshold` y el umbral usado. Sin umbral, o si falta la nota, el resultado es `unknown`: no se asume ninguna regla de aprobación.
`
`Limitación conocida: la lectura de inscripciones es la de siempre (`/users/me/memberships`); si el campus virtual no devuelve materias de ciclos anteriores, no hay historial que guardar. El resumen `history` de la actualización completa lo dice con números (`closed`, `inProgress`, `withFinalGrade`, `passed`, `failed`, `unknown`).
`
`### Automatización diaria
`
`La actualización diaria **no puede dispararse sola** con las reglas actuales: necesita una sesión de Blackboard y hoy esa sesión solo se obtiene con usuario, contraseña y MFA a mano, y no se guardan contraseñas, cookies ni secretos TOTP. Disparar la ruta diaria desde un programador solo tiene sentido cuando exista una autorización explícita sin contraseña (por ejemplo OAuth 3LO), que es una decisión institucional. Mientras tanto se ejecuta a mano con `npm run refresh:daily`.
`
`## Credenciales recordadas y actualización con ellas
`
`Decisión del titular del proyecto (reemplaza la regla anterior de "no guardar credenciales" **solo para quien lo pida**): un usuario puede pedir que se recuerden su usuario y contraseña de Blackboard para poder actualizar sin escribirlas.
`
`- **Consentimiento por usuario**: las credenciales solo se guardan si, al ejecutar `npm run refresh:full` o `refresh:daily`, se responde "s" a "¿Recordar estas credenciales?" (cuerpo `remember: true`). Sin esa respuesta, la contraseña se descarta como antes.
`- **Cifrado**: usuario y contraseña se guardan juntos en `account_credentials` (migración 0014), cifrados con AES-256-GCM; el AAD es el id de la cuenta. La clave (`CREDENTIALS_KEY`, 32 bytes en base64) vive en `.env`, que no se versiona, **nunca en la base**. Quien tenga la base **y** el `.env` puede descifrarlas: no los compartas ni subas `.env`.
`- **Nunca se muestran**: ni la API ni los logs devuelven credenciales; `npm run credentials -- status` solo indica quién las tiene y cómo le fue a la última ejecución.
`- **Borrado**: `npm run credentials -- forget <usuario>` las elimina.
`- **Sin esquivar el MFA**: el inicio de sesión con credenciales recordadas corre sin ventana (`SCHEDULED_LOGIN_VISIBLE=true` la muestra). Si UTEC pide un código de verificación o cambia el flujo, la ejecución falla con `mfa_required` (o `login_timeout`) y queda registrada en `last_error_code`; no se intenta saltar nada.
`- **Endpoint**: `POST /internal/dev/utec/refresh/stored` (sin cuerpo; mismas protecciones que las demás rutas internas) ejecuta la actualización diaria de todas las cuentas con credenciales recordadas y se consulta en `GET /internal/dev/utec/imports/:operationId` (`stored`: resultado por cuenta). Se registra con `trigger = scheduled`.
`- **La API no programa nada**: no hay rutinas ni temporizadores dentro de la API. Si más adelante se quiere automatizar, un programador externo debe llamar a ese endpoint.
`
`## Archivos de las materias y marcas de "revisado"
`
`**Ver y descargar archivos** (solo lectura, `GET`): la API sirve los archivos que el docente subió (`GET /courses/:cursoId/content/:contenidoId/file`, `?download=1` para descargar) y su vista previa de texto (`.../preview`: Word, PowerPoint, Excel, PDF, texto, documentos de Blackboard y enlaces). Todo parte de usuario → inscripción activa → contenido visible para esa inscripción; un archivo ajeno responde 404.
`- **Copia local**: la primera vez se descarga de Blackboard con la sesión del estudiante (inicio de sesión sin ventana con las credenciales recordadas; la sesión vive solo en memoria 15 min) y queda en `.state/files/<id>` (git la ignora). Después se abre al instante y sin sesión. Límite 150 MB por archivo (los videos grandes se abren en Blackboard). Sin copia ni credenciales recordadas: 503 claro.
`- **Servicio seguro**: solo se muestran en línea tipos que el navegador no ejecuta (PDF, imágenes, MP4, audio, texto plano); todo lo demás se entrega como descarga, con `nosniff`. Soporta `Range` (video y PDF grandes).
`- **Vista previa**: el HTML de Word se construye solo con texto escapado (nunca se copia HTML del archivo); PowerPoint y Excel se devuelven estructurados; un PDF escaneado se reporta como tal (haría falta OCR).
`- **Guías de una actividad**: \`GET /activities/:id\` devuelve \`guides\`: los archivos que comparten carpeta con el contenido de la actividad y que la inscripción puede ver (relación por carpeta, no un dato oficial de Blackboard).
`
`**Marcar como revisado** (excepción única a la regla de solo lectura, decidida por el titular del proyecto):
`- El estudiante lo pide con un clic (\`PUT .../reviewed\`, \`{ reviewed: true }\`); queda en \`content_review_marks\` como \`pending\`. Nunca se marca nada de forma automática.
`- En la siguiente actualización (completa, diaria, con credenciales recordadas o inicial), tras verificar la identidad y **antes** de leer datos, se envía cada marca pendiente con \`PATCH /learn/api/v1/courses/{curso}/contents/{contenido}/states/me { "reviewed": true }\`. Es la **única** escritura posible: la construye \`session.markReviewed\` con identificadores validados, no hay escritura genérica.
`- Si Blackboard ya muestra el contenido completado, no se envía nada (\`already_completed\`). Si rechaza la marca, se reintenta en cada actualización hasta 3 veces y queda \`failed\`; el estudiante puede volver a marcarla. Una marca ya enviada no se puede quitar desde la app (\`409 review_already_sent\`).
`- Blackboard registra la marca con la hora del **envío**, no la del clic; la interfaz lo dice.

**Ver Word, PowerPoint y Excel "tal cual"** (`GET .../content/:id/render`): los PDF se muestran como están (visor del navegador); Word, PowerPoint y Excel se convierten a PDF con el **Office instalado en este equipo** (Windows, Office 2016+) mediante `src/modules/files/office/convert.ps1` y el PDF se guarda junto a la copia (`.state/files/<id>.pdf`). Todo es local: ningún archivo sale a un servicio externo.
- Una conversión a la vez, con tiempo máximo de 3 minutos; la primera vez tarda unos segundos y después es instantáneo.
- Seguridad: se abre una **copia** en solo lectura, sin actualizar vínculos. Si la instancia de Office es nueva (solo de la conversión) se abre sin ventana, con macros deshabilitadas y sin alertas, y se cierra. Si Office ya estaba abierto con documentos del usuario y la conversión se pega a esa instancia, **no se cambia ningún ajuste ni se cierra**: solo se cierra el documento convertido, y los formatos antiguos (`.doc`, `.ppt`, `.xls`) no se convierten en ese caso (`shared_instance_legacy`). Los formatos con macros (`.docm`, `.xlsm`) nunca se convierten.
- Sin Office (otro sistema operativo o no instalado) o si la conversión falla, la app muestra su vista de texto estructurada (`/preview`) con un aviso.

**Actualización de la marca de "revisado"**: al presionar el botón, si hay credenciales recordadas, la API obtiene la sesión de Blackboard en el momento (la primera vez unos 10 s; luego ya está en memoria) y envía el `PATCH` **de inmediato**; la respuesta ya trae `state: 'sent'`. Si no se puede (sin credenciales, Blackboard rechaza o tarda más de 60 s), la marca queda `pending` con `sendFailed: true` y la siguiente actualización la reintenta (el fallo inmediato no gasta intentos). Un doble clic no envía dos veces. La cola de `content_review_marks` se mantiene como respaldo. Con el envío inmediato, Blackboard registra la marca con la hora del clic.
