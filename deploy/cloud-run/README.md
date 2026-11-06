# Desplegar Academic Hub en Google Cloud (Cloud Run)

Qué queda armado:

```
Usuario ──► Vercel (la web) ── /api/* ──► Cloud Run: API (Docker, con Chromium) ──► Cloud SQL (socket, sin IP ni certificado)
                                               ▲                 ▲
        Cloud Scheduler, cada 5 min ───────────┘                 └────── Telegram (webhook)
        GET /jobs/tick  (con CRON_SECRET)
```

> **Estado:** el código, las pruebas y el script en modo simulación (`-DryRun`) están verificados en la computadora de desarrollo.
> **Lo que no se ha probado** es el despliegue real: construir la imagen en Cloud Build, Chromium dentro de Cloud Run y el inicio de sesión
> de UTEC desde una IP de Google. El primer despliegue puede pedir algún ajuste; las pistas están al final.

## Qué cambia respecto a correrlo en tu computadora

En Cloud Run el servidor **solo tiene CPU mientras atiende una petición** y se apaga cuando nadie lo usa. Por eso nada corre "solo" por dentro:

| En tu PC (`BACKGROUND_JOBS=true`) | En Cloud Run (`BACKGROUND_JOBS=false`) |
|---|---|
| El servidor revisa los horarios cada 30 s | **Cloud Scheduler** llama a `GET /jobs/tick` cada 5 minutos |
| El servidor consulta a Telegram todo el tiempo | Telegram **avisa** a `POST /telegram/webhook` cuando alguien escribe |
| Recordatorios y avisos cada 30 s – 10 min | Se calculan y se mandan en cada `/jobs/tick` (cada 5 minutos) |
| Base de datos por IP con TLS | Conector de Cloud SQL (`DB_HOST=/cloudsql/PROYECTO:REGION:INSTANCIA`) |

Los **horarios no cambian de lugar**: siguen siendo `SCHEDULE_REFRESH_TIMES`, `SCHEDULE_WEEKLY_EMAIL`, etc. `/jobs/tick` solo pregunta
"¿toca algo ahora?"; cada horario corre **una sola vez** aunque se le llame muchas veces, y si una llamada se pierde, la siguiente lo recupera.

## Endpoints públicos de las rutinas

Todos piden la cabecera `Authorization: Bearer <CRON_SECRET>` (sin ella responden 401) y aceptan GET o POST.

| Endpoint | Qué hace | Quién lo llama |
|---|---|---|
| `/jobs/tick` | Corre las rutinas a las que les toca por horario, recalcula recordatorios y manda los avisos por Telegram. Responde al terminar. | Cloud Scheduler, cada 5 min |
| `/jobs/run?job=actualizar` | Corre **ahora** la rutina completa: Blackboard → calendario → guías → tareas → avisos. También `correo-semanal`, `correo-mensual`, `correo-diario`. | Tú, a mano (`run-job.ps1`) |
| `/jobs/scheduler` | Historial: las últimas 40 corridas con su estado y detalle. | Tú, para revisar |
| `/jobs/email-summary?kind=weekly\|monthly` | Manda el correo de resumen (una vez por periodo; `force=1` lo repite). | Lo usa la rutina; sirve a mano |
| `/jobs/notifications` | Solo recordatorios + avisos de Telegram. | Lo usa la rutina; sirve a mano |
| `/jobs/telegram/webhook` (POST) | Registra el webhook de Telegram (`{"baseUrl":"https://…"}`) o lo quita (`{"remove":true}`). | El script de despliegue |
| `/telegram/webhook` (POST) | Donde Telegram entrega los mensajes; se valida con un secreto que solo Telegram conoce. | Telegram |

`/jobs/utec/refresh`, `/jobs/utec/study-guides`, `/jobs/utec/homework` y `/jobs/utec/calendar` siguen existiendo, pero **en Cloud Run no los llames
sueltos**: `refresh` y `homework` responden enseguida y siguen trabajando después, y sin una petición abierta Cloud Run les quita la CPU.
Usa `/jobs/run?job=actualizar`, que mantiene la petición abierta hasta que todo termina.

## Antes de empezar

1. **Proyecto de Google Cloud con facturación activa** (el mismo donde está la base de datos es lo más simple). Anota su **id**.
2. **Nombre de conexión de la instancia de Cloud SQL**: consola → SQL → tu instancia → *Descripción general* → "Nombre de la conexión".
   Tiene la forma `proyecto:region:instancia`. La instancia debe tener IP pública habilitada (ya la tiene si te conectas desde tu PC).
3. **Google Cloud CLI** en tu computadora: <https://cloud.google.com/sdk/docs/install>. Después, en una terminal nueva:
   ```powershell
   gcloud auth login
   ```
   Docker **no** hace falta: la imagen se construye en Google (Cloud Build).

## 1. Variables

```powershell
cd academic-hub-backend
Copy-Item deploy\cloud-run\env.example .env.cloudrun
notepad .env.cloudrun
```

- `DB_NAME`, `DB_USER`, `DB_PASSWORD`: los mismos de tu `.env` si vas a usar la misma base de datos.
- `CREDENTIALS_KEY`: con la **misma base**, la **misma clave** de tu `.env`; si no, las credenciales recordadas de UTEC no se pueden descifrar.
- `CRON_SECRET`: genera una **nueva** (solo letras y números, 32 o más): `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
- `FRONTEND_ORIGIN`: la dirección exacta de la web (`https://tu-app.vercel.app`, sin barra final). Si todavía no existe, pon la que vayas a usar y corrige después.
- No pongas `DB_HOST`, `DB_SSL_*`, `PORT`, `HOST`, `BACKGROUND_JOBS` ni `DEV_OPERATOR_TOKEN`: el despliegue los define o los prohíbe.

`.env.cloudrun` no se sube a GitHub (`.gitignore`) ni a Cloud Build (`.gcloudignore`).

## 2. Desplegar

Primero una simulación, que solo muestra lo que haría:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\cloud-run\deploy.ps1 -Project TU-PROYECTO -SqlInstance TU-PROYECTO:us-central1:TU-INSTANCIA -DryRun
```

Y luego de verdad (quita `-DryRun`). Usa en `-Region` la misma región de la base de datos (por defecto `us-central1`). El script:

1. Activa los servicios necesarios (Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Scheduler, Cloud SQL Admin).
2. Crea la cuenta de servicio `academic-hub-run` con permiso para conectarse a Cloud SQL y leer los secretos.
3. Guarda las claves en **Secret Manager** (`academic-hub-db-password`, `academic-hub-cron-secret`, …). Las demás variables van como variables normales del servicio.
4. Construye la imagen y despliega `academic-hub-api`: 1 CPU, 2 GB, una sola instancia, se apaga sin uso, peticiones de hasta 60 minutos. Al arrancar aplica las migraciones pendientes.
5. Crea la tarea `academic-hub-tick` en Cloud Scheduler (cada 5 minutos, hora de El Salvador).
6. Registra el webhook de Telegram y comprueba `/health/db`.

Se puede repetir sin miedo: actualiza lo que ya existe. **Para subir una versión nueva del código es el mismo comando.**

## 3. La web (Vercel)

1. En el repositorio del **frontend**, abre `vercel.json` y cambia `REEMPLAZA-CON-TU-DOMINIO-DE-LA-API` por el dominio que imprimió el script (sin `https://`).
2. En Vercel: *Add New → Project* → importa el repo del frontend. Framework **Vite**, build `npm run build`, salida `dist`.
3. Si la dirección final de la web no es la que pusiste en `FRONTEND_ORIGIN`, corrígela en `.env.cloudrun` y vuelve a ejecutar el script.

La web llama a `/api/*` en su propio dominio y Vercel lo reenvía a Cloud Run: así la cookie de sesión funciona sin configuración extra.

## 4. Comprobar

```powershell
# Corre ya la rutina completa y espera el resultado (varios minutos la primera vez):
powershell -ExecutionPolicy Bypass -File deploy\cloud-run\run-job.ps1 -Url https://LA-DIRECCION.run.app
# Historial de corridas:
powershell -ExecutionPolicy Bypass -File deploy\cloud-run\run-job.ps1 -Url https://LA-DIRECCION.run.app -Job historial
# Registros del servidor:
gcloud run services logs read academic-hub-api --project TU-PROYECTO --region us-central1 --limit 80
```

En la consola: *Cloud Scheduler* muestra cada llamada a `/jobs/tick` y su resultado; "Forzar ejecución" la dispara al momento.

## 5. En tu computadora, después

Pon `BACKGROUND_JOBS=false` en tu `.env` local (o no dejes corriendo el servidor de desarrollo). Con el webhook activo Telegram rechaza que
otro programa lo consulte, y así tampoco se cruzan las rutinas de tu PC con las de la nube. Para volver a atender Telegram desde tu PC,
quita el webhook: `POST /jobs/telegram/webhook` con `{"remove":true}`.

## Costo aproximado

Con dos personas, Cloud Run, Cloud Scheduler (1 tarea) y Secret Manager deberían caber en la capa gratuita o costar muy poco: el servidor solo
cobra mientras atiende peticiones (unos segundos por cada `/jobs/tick` y unos minutos, tres veces al día, cuando toca actualizar).
La imagen guardada en Artifact Registry (~1.5 GB por Chromium) cuesta centavos al mes. **Cloud SQL se cobra aparte, como hasta ahora.**
Confirma los precios vigentes en la calculadora de Google Cloud; pon una alerta de presupuesto en *Facturación → Presupuestos y alertas*.

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| El despliegue falla al construir | El registro de Cloud Build que enlaza el error. Si es de permisos de la cuenta de Cloud Build, dale el rol *Cloud Run Builder* a la cuenta de servicio que indique el mensaje. |
| El servicio no arranca: `Configuración inválida: …` | Los registros dicen qué variable falta o está mal. Corrige `.env.cloudrun` y repite el script. |
| No arranca y los registros hablan de la base de datos | Que `-SqlInstance` sea el nombre de conexión exacto, que usuario/contraseña/base sean correctos y que el servidor sea PostgreSQL 18. |
| `/jobs/tick` responde 401 | El `CRON_SECRET` de Cloud Scheduler no coincide: repite el script (actualiza la tarea). |
| La rutina `actualizar` falla con error de inicio de sesión | Prueba `BLACKBOARD_LOGIN_MODE=auto`. Si UTEC bloquea las IP de Google, la actualización puede seguir corriendo desde tu PC contra la misma base (allí `BACKGROUND_JOBS=true`, y quita el webhook). |
| Los PDF no se arman o el servidor se reinicia por memoria | Sube la memoria: en `deploy.ps1` cambia `'--memory', '2Gi'` por `'4Gi'` (y `'--cpu', '2'`). |
| Cloud Scheduler marca error por tiempo (30 min) | Una corrida muy larga corta esa llamada, pero la siguiente (5 min después) no arranca otra rutina: espera a la que sigue en curso y la deja terminar. Revisa el resultado en `-Job historial`; si pasa seguido, baja `HOMEWORK_MAX_PER_RUN`. |
| Telegram no responde | Repite el script (vuelve a registrar el webhook) y revisa que tu PC no esté corriendo con `BACKGROUND_JOBS=true`. |
| La primera página tarda unos segundos | Es el arranque en frío tras un rato sin uso. Con el tick cada 5 minutos casi nunca se nota; `--min-instances 1` lo elimina, pero cobra todo el mes. |
| El visor de Word/Excel/PowerPoint muestra solo texto | Es lo esperado en Linux: necesita Office de Windows. La descarga del archivo original sí funciona. |
