# Arquitectura de base de datos — Academic Hub

PostgreSQL 18 · esquema propio `academic_hub` · migraciones SQL versionadas en `src/database/migrations/`.

| Base | Uso |
|---|---|
| `header_dev` | Base de trabajo (todos los cambios). Configurada en `.env` (`DB_NAME`). |
| `aether` | Base limpia ("pasar a limpio"). Aún sin migraciones de Academic Hub; se migra de forma explícita con `DB_NAME=aether npm run db:migrate`. |

El esquema `academic_hub_demo` (creado con `npm run demo:seed`) contiene solo datos ficticios para capturas. Las pruebas automatizadas usan un esquema desechable `academic_hub_test` dentro de la base de trabajo y lo eliminan al terminar; nunca tocan `academic_hub`.

## Decisiones (derivadas de `CLAUDE_BLACKBOARD_ARCHITECTURE_REVIEW.md`)

- **PK internas `uuid DEFAULT uuidv7()`** (nativa en PG18). Los IDs de Blackboard (`_123_1`) se guardan como `text` y son únicos **dentro de su ámbito** (institución o curso), nunca globales.
- **La columna del libro de calificaciones es la actividad canónica.** Calendario (`GradableItem`) y pendientes son proyecciones enlazadas por ID, no actividades nuevas.
- **Catálogo compartido ≠ visibilidad compartida.** Contenido, columnas y anuncios se guardan una vez por curso, pero la API solo los sirve a través de tablas por inscripción.
- **FKs compuestas `(id, course_id)`**: la base impide que una nota, una visibilidad, un intento o un ítem de ciclo apunten a un recurso de otra materia distinta a la de la inscripción.
- **Nota = `(enrollment_id, gradebook_column_id)`**; `external_grade_id` es informativo porque Blackboard lo devuelve `null` en columnas calculadas.
- **Borrado lógico**: `missing_since` / `removed_at_source`; una sincronización nunca borra físicamente.
- **Idempotencia**: upserts `ON CONFLICT` con `content_hash` (SHA-256 de campos de negocio) y `RETURNING old/new` de PG18 para distinguir insertado / actualizado / sin cambios.
- **`student_profiles` fusionado en `external_accounts`**; **`student_academic_terms` es una vista** (`student_terms`).
- **Minimización**: no se guardan nacimiento, género, dirección, teléfono, promedio de la clase ni nombres de docentes.
- **Sin almacenamiento de secretos universitarios**: no existe tabla para contraseñas UTEC, cookies ni TOTP.

## Diagrama ER (simplificado)

```text
users ─1:N─ auth_sessions            users ─1:N─ auth_tokens          users ─1:N─ audit_events
  │
  └─1:N─ external_accounts ─N:1─ institutions ─1:N─ academic_terms ─1:N─ courses
              │        └─ preferred_current_term_id → academic_terms         │
              │                                                               │
              ├─1:N─ sync_runs ─1:N─ sync_run_steps                           │
              │                                                               │
              └─1:N─ course_enrollments ─N:1──────────────────────────────────┘
                        │                                  courses ─1:N─ course_content_items (árbol: parent_id)
                        ├─1:N─ enrollment_content_visibility ─N:1─ course_content_items
                        ├─1:N─ student_grades ─N:1─ gradebook_columns ─N:1─ course_content_items
                        │          └─1:N─ grade_attempts         └─N:1─ grading_schemas
                        ├─1:N─ due_date_exceptions
                        ├─1:N─ todo_observations ─N:1─ gradebook_columns
                        ├─1:N─ enrollment_announcements ─N:1─ course_announcements
                        └─1:N─ evaluation_cycles ─1:N─ evaluation_cycle_items ─N:1─ gradebook_columns
calendar_items (scope: course | personal | institution) ─ gradebook_column_id (proyección GradableItem)
entity_changes (log de cambios de negocio, shared | personal)
```

## Tablas

### Identidad y autenticación (0002)

| Tabla | Columnas clave | Restricciones |
|---|---|---|
| `users` | `id`, `email`, `username`, `password_hash` (Argon2id PHC), `must_change_password`, `display_name`, `status`, `email_verified_at`, `password_changed_at`, `deleted_at` | `UNIQUE lower(email)`; `UNIQUE username`; `CHECK` de formato |
| `auth_sessions` | `token_hash bytea(32)`, `csrf_token_hash bytea(32)`, `expires_at`, `last_used_at`, `revoked_at`, `revoked_reason`, `ip_hash` | `UNIQUE token_hash`; índice parcial de sesiones activas |
| `auth_tokens` | `purpose` (`email_verification`/`password_reset`/`initial_password`), `token_hash`, `expires_at`, `used_at` | uso único; preparada, sin proveedor de correo |
| `audit_events` | `event`, `outcome`, `ip_hash`, `metadata jsonb` | nunca contiene contraseñas ni tokens |

### Institución y cuenta universitaria (0003)

| Tabla | Columnas clave | Restricciones |
|---|---|---|
| `institutions` | `code`, `lms_provider`, `lms_base_url`, `timezone`, `auth_mode` (`user_session`/`oauth_3lo`) | `UNIQUE code` |
| `external_accounts` | `lms_user_id`, `lms_uuid`, `lms_foundations_id`, `lms_username`, `given_name`, `family_name`, `preferred_display_name`, `institutional_email`, `locale`, `system_role`, `link_status`, `linked_at`, `last_verified_at`, `last_successful_sync_at`, `preferred_current_term_id` | una cuenta activa por usuario e institución; **una identidad Blackboard activa vinculada a un solo usuario** (`UNIQUE (institution_id, lms_user_id) WHERE link_status <> 'revoked'`); `active` exige identidad verificada |

### Sincronización (0004) y cambios (0009)

| Tabla | Columnas clave | Restricciones |
|---|---|---|
| `sync_runs` | `trigger`, `status`, `adapter_version`, `stats jsonb`, `error_code` (sanitizado) | **una sola ejecución `running` por cuenta** (índice único parcial) |
| `sync_run_steps` | `resource`, `course_external_id`, `status`, `complete`, `truncated`, `pages`, `items`, `http_status_counts` | `complete` solo si `succeeded` y no truncado |
| `entity_changes` | `entity_type`, `entity_id`, `scope`, `course_id` (0011), `change_type`, `changed_fields`, `before`, `after` (incluye `kind`) | alimentada por el importador desde la Fase 2 del frontend; ver reglas abajo |

**Reglas de novedades** (`src/modules/import/changes.ts`):

- Primera importación de la cuenta = línea base (sin novedades). Una materia o inscripción nueva tampoco genera novedades por sus propios elementos.
- Tipos (`after.kind`): `term_new`, `course_new` (personales); `activity_new`, `due_changed`, `activity_renamed`, `points_changed`, `announcement_new` (compartidos, con `course_id`); `grade_new`, `grade_changed`, `submission_changed` (personales).
- Los valores antes/después salen de `RETURNING old/new` del propio upsert; solo campos de negocio.
- Nunca se registran eliminaciones; una lectura fallida o incompleta no genera cambios.
- Un cambio compartido se muestra a un estudiante solo si estaba inscrito antes de su detección.

### Catálogo compartido (0005)

| Tabla | Clave natural | Notas |
|---|---|---|
| `academic_terms` | `(institution_id, external_id)` | solo períodos referenciados por inscripciones |
| `courses` | `(institution_id, external_id)` | `term_id` + `term_external_id`; `batch_uid`, `lms_url` |
| `course_content_items` | `(course_id, external_id)` | árbol con `parent_id` (FK compuesta, mismo curso), `content_detail jsonb`, `due_at` (`genericReadOnlyData`), `source_modified_at` (epoch ms → timestamptz), HTML sanitizado |
| `grading_schemas` | `(course_id, external_id)` | `symbols jsonb` |
| `gradebook_columns` | `(course_id, external_id)` | `content_item_id` (FK compuesta), `is_calculated` + `calculated_formula jsonb`, `is_deleted_at_source` |
| `course_announcements` | `(course_id, external_id)` | solo `creator_external_id` |
| `calendar_items` (0007) | `(institution_id, course_id, external_account_id, source_type, source_external_id) NULLS NOT DISTINCT` | `is_gradable_projection` generado; una proyección por columna |

### Datos por inscripción (0006)

| Tabla | Clave | Notas |
|---|---|---|
| `course_enrollments` | `(external_account_id, course_id)`; `(course_id, external_id)` | misma institución en cuenta y curso (FKs compuestas) |
| `enrollment_content_visibility` | `(enrollment_id, content_item_id)` | **fuente de autorización** del árbol: `visibility`, `has_release_rules`, `completion` |
| `student_grades` | `(enrollment_id, gradebook_column_id)` | una fila por columna visible, con o sin nota; `is_submitted` derivado de intentos; `effective_due_at` + fuente |
| `grade_attempts` | `(course_id, external_id)` | solo intentos propios; `submitted_at` = recibo |
| `due_date_exceptions` | `(enrollment_id, source_key)` | estructura mínima + `raw` (forma real aún no observada) |
| `enrollment_announcements` | `(enrollment_id, announcement_id)` | lectura y visibilidad personal |
| `todo_observations` | `(enrollment_id, gradebook_column_id)` | última observación del widget de pendientes |

### Ciclos evaluativos (0008)

`evaluation_cycles (enrollment_id, number 1–10)` con un único ciclo activo por inscripción; una sugerencia (`formula_suggestion`/`ai_suggestion`) no puede activarse sin `confirmed_at`. `evaluation_cycle_items` exige que la columna pertenezca a la misma materia y a un solo ciclo por inscripción.

### Vista (0010)

`student_terms`: períodos del estudiante derivados de inscripciones activas, con `is_current_by_date` (puede haber varios) e `is_preferred_current`.

## Índices destacados

`course_enrollments (external_account_id) WHERE status='active'` · `gradebook_columns (course_id, due_at) WHERE NOT is_deleted_at_source` · `student_grades (enrollment_id, effective_due_at)` · `course_content_items (course_id, parent_id, position)` · `calendar_items (course_id, start_at)` · `entity_changes (external_account_id, detected_at DESC)`.

## Verificación

`npm run db:verify` imprime tablas, conteos y ejecuta 17 comprobaciones de restricciones dentro de una transacción revertida (resultado actual: 17/17 OK, 55 FKs, 25 UNIQUE, 83 CHECK, 80 índices, 1 vista).

## Campos pendientes de evidencia

- Forma de cada excepción de vencimiento (endpoint 200, sin ejemplos reales).
- Eventos `CalendarEntry` / institucionales (no aparecieron en la ventana importada).
- Detección de ausencias (`missing_since`): el esquema está listo; el importador aún no marca ausencias (las novedades sí se registran desde la migración 0011).
