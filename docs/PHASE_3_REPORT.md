# Reporte de la Fase 3 — Importación UTEC, cuenta Academic Hub y frontend

Fecha: 2026-10-28. Sin credenciales, nombres personales ni calificaciones.

## Conexión y base

PostgreSQL 18.4, base `header_dev`, 10 migraciones aplicadas y verificadas antes de comenzar.

## Endpoint interno

`POST /internal/dev/utec/create-user` + `GET /internal/dev/utec/imports/:operationId` (solo desarrollo, loopback, token de operador, sin navegadores). Cliente: `npm run dev:import`. Detalle en `UTEC_IMPORT_IMPLEMENTATION.md`.

## Ejecución real

| Intento | Resultado |
|---|---|
| 1 | Login correcto; falló al construir el cliente del SDK (`ZodError`: `maxDownloadBytes` por debajo del mínimo de `blackboard-mcp`). Nada persistido. Corregido. |
| 2 | **Completado.** Sincronización con los 12 pasos `succeeded` y completos, sin truncamientos, todas las respuestas HTTP 200. |

### Recursos importados (cuenta del titular)

| Recurso | Filas |
|---|---:|
| Usuario Academic Hub creado | 1 (contraseña temporal, cambio obligatorio pendiente) |
| Cuenta universitaria vinculada | 1 (`active`) |
| Períodos | 1 |
| Materias / inscripciones | 2 / 2 |
| Nodos de contenido | 176 (153 con padre) |
| Columnas | 19 (17 actividades + 2 calculadas; 12 enlazadas a contenido) |
| Filas de nota (columnas visibles) | 19 |
| Intentos propios | 10 |
| Ítems de calendario | 12 (12 enlazados a su columna) |
| Anuncios | 4 |
| Pendientes observados | 5 |
| Excepciones de vencimiento | 0 |

Datos incompletos: ninguno en esta ejecución. Recursos no importados por diseño: archivos/descargas, mensajes, foros, rosters.

## Cuenta Academic Hub

Creada con username propio (`nombre.apellido`), correo institucional verificado por Blackboard, contraseña temporal CSPRNG entregada una sola vez y `must_change_password = true`. Una segunda importación reutiliza la cuenta sin cambiar la contraseña (probado con el transporte simulado; la reimportación real no se ha ejecutado).

## Frontend

Ver `academic-hub-frontend/docs/FRONTEND_IMPLEMENTATION.md`. Rutas: `/login`, `/change-password`, `/dashboard`, `/courses`, `/courses/:id`, `/activities`, `/profile`.

## Pruebas realizadas

- Backend: 32/32 (`npm test`), incluidas las de seguridad del endpoint interno y el importador simulado.
- Frontend: `tsc` sin errores y `vite build` correcto.
- Visual (Playwright, 1440×900 y 390×844): login (vacío, validación, error real de la API) y dashboard/perfil en estado vacío con un usuario temporal creado y eliminado al terminar. Sin desplazamiento horizontal.
- **No verificado por mí**: el dashboard con tus datos reales, porque requiere tu contraseña temporal. Pendiente de tu primer login.

## Pendiente

- Primer login del titular y revisión visual con datos reales.
- `entity_changes` / novedades, marcado de ausencias, vinculación desde la app y sincronización programada (requiere decisión institucional).
- Pruebas automatizadas de frontend (componentes/E2E).
