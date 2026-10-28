# academic-hub-backend

API REST de Academic Hub: Node.js + TypeScript + Fastify + PostgreSQL 18 (directo con `pg`, sin Supabase).

## Requisitos

- Node.js ≥ 22.6 (probado con 26).
- PostgreSQL 18 con `uuidv7()`.
- Chromium de Playwright (solo para la importación de desarrollo).

## Configuración

Copia `.env.example` a `.env` y completa `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (o `DATABASE_URL`). Otras variables:

| Variable | Descripción |
|---|---|
| `DB_SSL_MODE` | `disable` (local), `require` (cifrado sin verificar; prohibido en producción), `verify-full` (+ `DB_SSL_CA_FILE` opcional) |
| `DB_SCHEMA` | esquema propio (`academic_hub`) |
| `FRONTEND_ORIGIN` | origen exacto del frontend (validación de Origin) |
| `SESSION_TTL_DAYS`, `COOKIE_SECURE`, `COOKIE_SAME_SITE` | sesión y cookies (ver `docs/BACKEND_API.md`) |
| `DEV_OPERATOR_TOKEN` | solo desarrollo: habilita `/internal/dev` en loopback |

## Comandos

```bash
npm run db:check     # conexión, versión 18, permisos (sin mostrar secretos)
npm run db:migrate   # aplica migraciones (se niega ante tablas ajenas)
npm run db:status    # estado de migraciones
npm run db:verify    # verifica estructura y restricciones (transacción revertida)
npm run dev          # API en http://127.0.0.1:4000
npm test             # 32 pruebas (esquema desechable academic_hub_test)
npm run dev:import   # onboarding desde Blackboard UTEC (solo desarrollo)
```

## Documentación

- `docs/DATABASE_ARCHITECTURE.md`
- `docs/BACKEND_API.md`
- `docs/UTEC_IMPORT_IMPLEMENTATION.md`
- `docs/BACKEND_IMPLEMENTATION_REPORT.md`
- `docs/PHASE_3_REPORT.md`

Referencia arquitectónica: `../poc/blackboard-mcp-auth-poc/docs/CLAUDE_BLACKBOARD_ARCHITECTURE_REVIEW.md`.
