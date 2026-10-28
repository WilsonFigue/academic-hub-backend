# Reporte de implementación del backend (Fase 2)

Fecha: 2026-10-28. Solo se reportan resultados ejecutados.

## Stack y dependencias

| Paquete | Uso |
|---|---|
| `fastify` 5, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/swagger` | API, cookies de sesión, límites, OpenAPI |
| `pg` 8 | PostgreSQL directo (pool, consultas parametrizadas, transacciones) |
| `@node-rs/argon2` | Argon2id (binarios precompilados, sin scripts de instalación) |
| `playwright` 1.58.0, `blackboard-mcp` 0.1.2 (fijado) | solo el flujo interno de importación (carga dinámica) |
| `typescript`, `tsx`, `@types/*` | desarrollo |

Instalación con `--ignore-scripts`. `npm audit` (2026-10-28): **2 vulnerabilidades altas**, ambas por `zod <4.6.6` (GHSA-mrhx-c7xc-m3w5, agotamiento de memoria) dentro de `blackboard-mcp@0.1.2`, sin corrección disponible para esa versión. Mitigación: el SDK solo se carga dinámicamente en el flujo interno de desarrollo y nunca procesa entradas de la API pública. Debe eliminarse del camino de producción (adaptador propio / OAuth 3LO). El frontend: 0 vulnerabilidades.

## Conexión

- Servidor: PostgreSQL **18.4**, `uuidv7()` disponible.
- `npm run db:check`: conexión, `SELECT 1`, versión, base, esquema y privilegios → **OK**.
- TLS: el servidor exige cifrado. `DB_SSL_MODE=require` (cifrado sin verificar certificado, igual que el proyecto Volao) permitido solo fuera de producción; producción exige `verify-full` (validado al arrancar).
- Bases: `header_dev` (trabajo, renombrada desde `academic_hub_dev`) y `aether` (limpia, sin migraciones de Academic Hub).

## Migraciones aplicadas en `header_dev`

`0001_foundation` · `0002_identity_auth` · `0003_institutions_accounts` · `0004_sync` · `0005_academic_catalog` · `0006_enrollments_personal` · `0007_calendar` · `0008_evaluation_cycles` · `0009_entity_changes` · `0010_student_terms_view`. Reaplicar → "No hay migraciones pendientes".

22 tablas + `schema_migrations` + vista `student_terms`. 55 FKs, 25 UNIQUE, 83 CHECK, 80 índices. El migrador usa advisory lock, una transacción por migración, rechaza migraciones aplicadas modificadas y **se niega a operar sobre un esquema con tablas ajenas**.

## Comandos

`dev`, `start`, `build`, `typecheck`, `test`, `db:check`, `db:migrate`, `db:status`, `db:verify`, `db:create -- <nombre>`, `db:rename -- <actual> <nuevo>`, `dev:import`.

## Pruebas (`npm test`) — 32/32 aprobadas

- Salud (2): `/health`, `/health/db` sin BD.
- Autenticación (10): registro, contraseña corta y correo duplicado, login correcto/incorrecto/inexistente con mismo mensaje, 401 sin sesión, CSRF + logout, Origin ajeno, sesión expirada, logout-all, contraseña temporal obligatoria, rate limit.
- Multiusuario (9): materias por usuario, UUID ajeno → 404, visibilidad de contenido independiente, notas independientes y columna restringida, actividad ajena → 404, columnas calculadas excluidas, calendario sin duplicar `GradableItem`, períodos derivados de inscripciones, cuenta universitaria ajena → 404.
- Endpoint interno (8): sin token, token incorrecto, con Origin, IP no loopback, campos extra, sin eco de credenciales, operación inexistente, ruta inexistente sin registro.
- Importador simulado (3): primera importación completa, segunda sin duplicados ni reescrituras, login con cambio obligatorio y dashboard.

`npm run db:verify`: 17/17 restricciones verificadas dentro de una transacción revertida.

## Hallazgo corregido durante las pruebas

El rate limit de credenciales usaba como clave la IP sin el identificador, porque se evaluaba antes de leer el cuerpo: todas las cuentas de una IP compartían el contador. Ahora se evalúa en `preHandler` con clave `IP + identificador`.

## Pendiente

- Escritura de `entity_changes` y marcado de ausencias (`missing_since`) en el importador.
- Vinculación desde la app y sincronización programada (dependen de OAuth 3LO con UTEC).
- Proveedor de correo para verificación/recuperación.
- Row Level Security como defensa adicional.
- Migrar la base limpia `aether` cuando se decida.
