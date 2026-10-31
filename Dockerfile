# Academic Hub · backend para un VPS (Linux). Incluye Chromium para los PDF de las guías y tareas y para el login de UTEC.
# Construir y arrancar: docker compose up -d --build   (ver deploy/README.md)

# ── 1. Compilar TypeScript ────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build \
 # tsc no copia los .sql: las migraciones se leen junto al código compilado.
 && cp -r src/database/migrations dist/src/database/migrations

# ── 2. Imagen final: solo dependencias de producción + Chromium ───────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && apt-get install -y --no-install-recommends fonts-liberation fonts-dejavu-core curl \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
# Algunas rutas leen archivos junto al código fuente (migraciones ya copiadas; el conversor de Office solo existe en Windows).
COPY src ./src
RUN mkdir -p /app/.state /app/certs && chown -R node:node /app/.state /app/certs
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD curl -fsS http://127.0.0.1:4000/health || exit 1
# Las migraciones pendientes se aplican al arrancar (son aditivas y se registran en schema_migrations).
CMD ["sh", "-c", "node dist/scripts/db-migrate.js && node dist/src/server.js"]
