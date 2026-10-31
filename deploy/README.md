# Desplegar Academic Hub en un VPS

Qué queda armado:

```
Usuario ──► Vercel (la web)  ── /api/* ──►  VPS: Caddy (HTTPS) ─► API (Docker, con Chromium) ──► Google Cloud SQL
                                                  ▲
                              cron del VPS ───────┘  (rutinas /jobs/*)        Telegram: el servidor lo atiende solo
```

> **Importante:** la imagen de Docker **no se ha probado todavía** (en la computadora de desarrollo no hay Docker). Lo que sí se probó:
> el código compilado arranca en modo producción, aplica las reglas de configuración, no expone las rutas de desarrollo y las rutinas
> `/jobs/*` piden la clave. El primer `docker compose up` puede pedir algún ajuste; las pistas están al final.

## 1. Contratar el VPS
- Ubuntu **24.04 LTS** sin paneles, ubicación **Estados Unidos**, plan con **al menos 2 GB de RAM** (mejor 4 GB por Chromium).
- Anota la **IP** del servidor. Agrega tu llave SSH pública en el panel (o usa la contraseña de root solo para el primer acceso).

## 2. Un nombre para la API (gratis)
1. Entra a <https://www.duckdns.org> con Google o GitHub.
2. Crea un subdominio, por ejemplo `academichub-api`, y pega la **IP del VPS**. Quedará `academichub-api.duckdns.org`.

## 3. Preparar el servidor
```bash
ssh root@IP_DEL_VPS
apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh          # instala Docker y Docker Compose
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
mkdir -p /opt/academic-hub && cd /opt/academic-hub
```

## 4. Subir el código
Con Git (repositorio privado: usa un token de GitHub como contraseña):
```bash
git clone https://github.com/WilsonFigue/academic-hub-backend.git .
git checkout feature/academic-hub        # la rama con estos cambios
```

## 5. Base de datos (Google Cloud SQL)
1. **Autorizar la IP del VPS:** consola de Cloud SQL → tu instancia → *Conexiones* → *Redes autorizadas* → agrega `IP_DEL_VPS/32`.
2. **Certificado del servidor:** *Conexiones* → *Seguridad* → descarga el *certificado de la CA del servidor* y guárdalo en el VPS como
   `/opt/academic-hub/certs/server-ca.pem` (`mkdir -p certs` y súbelo con `scp`).
3. En producción la conexión debe ser `verify-full` (la app lo exige). Si falla por el *nombre* del certificado, define `DB_SSL_SERVERNAME`.

## 6. Configurar
```bash
cp deploy/production.env.example .env.production     # y rellena los valores (nano .env.production)
echo "API_DOMAIN=academichub-api.duckdns.org" > .env
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # úsalo como CRON_SECRET (o: openssl rand -hex 24)
```
Puntos clave de `.env.production`:
- `FRONTEND_ORIGIN`: el origen **exacto** de la web en Vercel (`https://tu-app.vercel.app`, sin barra final). Si todavía no lo tienes, déjalo y vuelve a este paso en el 9.
- `CREDENTIALS_KEY`: si usas **la misma base de datos** que en desarrollo, debe ser **la misma clave**; si no, las credenciales recordadas de UTEC no se podrán descifrar.
- `CRON_SECRET`: mínimo 32 caracteres.
- No pongas `DEV_OPERATOR_TOKEN`: en producción está prohibido.

## 7. Arrancar
```bash
docker compose up -d --build
docker compose logs -f api              # debe verse "Server listening" y "Rutinas /jobs habilitadas"
curl https://academichub-api.duckdns.org/health        # {"status":"ok"}
curl https://academichub-api.duckdns.org/health/db     # confirma la conexión a la base de datos
```
Al arrancar, la API aplica sola las migraciones pendientes.

## 8. Tareas programadas
```bash
chmod +x deploy/run-job.sh
crontab -e            # pega el contenido de deploy/crontab.example
./deploy/run-job.sh /jobs/utec/imports/00000000-0000-4000-8000-000000000000    # prueba: debe responder 404 «Operación no encontrada»
```
Los horarios están en UTC (El Salvador es UTC-6). Telegram y los recordatorios de entrega **no** van en el cron: el servidor los hace solo.

## 9. La web en Vercel
1. En el repositorio del **frontend**, abre `vercel.json` y cambia `REEMPLAZA-CON-TU-DOMINIO-DE-LA-API` por `academichub-api.duckdns.org`.
2. En Vercel: *Add New → Project* → importa el repo del frontend. Framework: **Vite**; comando de build `npm run build`; carpeta de salida `dist`.
3. Copia la URL que te da Vercel y ponla como `FRONTEND_ORIGIN` en `.env.production` del VPS; luego `docker compose up -d` para recargar.

## 10. Comprobar
- Abre la web, inicia sesión, abre una guía y una tarea (se sirven desde la base de datos).
- `docker compose exec api node -e "console.log('ok')"` para ver que el contenedor responde.
- Los mensajes de Telegram y la campana funcionan con el servidor encendido.

## Cuando el VPS ya esté funcionando
- **Apaga Telegram en tu computadora:** pon `BACKGROUND_JOBS=false` en tu `.env` local (o no corras el servidor de desarrollo). Si los dos atienden al mismo bot, Telegram da conflictos y se pierden mensajes.
- Tu computadora sigue sirviendo para las rutinas de desarrollo (`/internal/dev/...`) contra la misma base de datos, si algún día las necesitas.

## Actualizar a una versión nueva
```bash
cd /opt/academic-hub && git pull && docker compose up -d --build
```

## Si algo falla
| Síntoma | Qué mirar |
|---|---|
| `Configuración inválida: …` al arrancar | La app dice qué variable falta o es incorrecta (por ejemplo `DB_SSL_MODE` debe ser `verify-full`). |
| Error de certificado al conectar a la base | Que `certs/server-ca.pem` exista y sea el de **tu instancia**; si es de nombre, prueba `DB_SSL_SERVERNAME`. |
| `connection timed out` a la base | La IP del VPS no está autorizada en Cloud SQL (paso 5.1). |
| Los PDF no se arman | `docker compose logs api` y revisa Chromium; el `shm_size: 1gb` del compose es necesario. |
| UTEC rechaza el inicio de sesión desde el servidor | Prueba `BLACKBOARD_LOGIN_MODE=auto`. Si UTEC bloquea la IP del servidor, corre la actualización desde tu PC apuntando a la misma base de datos. |
| Telegram no responde | Que `TELEGRAM_BOT_TOKEN` esté puesto y no haya un webhook registrado (la API atiende con *long polling*). |
| El visor de Word/Excel/PowerPoint muestra solo texto | Es lo esperado en Linux: necesita Office de Windows. La descarga del archivo original sí funciona. |
