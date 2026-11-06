<#
.SYNOPSIS
  Despliega la API de Academic Hub en Google Cloud Run y deja programadas las rutinas (Cloud Scheduler -> GET /jobs/tick).

.DESCRIPTION
  Lee las variables de .env.cloudrun (copia de deploy/cloud-run/env.example), guarda las claves en Secret Manager,
  construye la imagen con Cloud Build, despliega el servicio conectado a Cloud SQL, crea la tarea de Cloud Scheduler
  y registra el webhook de Telegram. Se puede repetir las veces que haga falta: actualiza lo que ya existe.
  Guia paso a paso: deploy/cloud-run/README.md. (Este archivo va sin tildes a proposito: Windows PowerShell 5.1 las lee mal.)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\cloud-run\deploy.ps1 -Project mi-proyecto -SqlInstance mi-proyecto:us-central1:mi-instancia

.EXAMPLE
  Lo mismo con -DryRun al final: solo muestra lo que haria, sin tocar nada (no necesita gcloud).
#>
[CmdletBinding()]
param(
  # Id del proyecto de Google Cloud donde se despliega.
  [Parameter(Mandatory = $true)][string]$Project,
  # Nombre de conexion de la instancia de Cloud SQL: PROYECTO:REGION:INSTANCIA (consola de Cloud SQL -> Descripcion general).
  [Parameter(Mandatory = $true)][string]$SqlInstance,
  [string]$Region = 'us-central1',
  [string]$Service = 'academic-hub-api',
  [string]$EnvFile = '.env.cloudrun',
  # Cada cuanto Cloud Scheduler llama a /jobs/tick (formato cron). Los horarios reales de las rutinas son los SCHEDULE_* del archivo de variables.
  [string]$TickSchedule = '*/5 * * * *',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location (Join-Path $PSScriptRoot '..\..')          # raiz del backend (donde esta el Dockerfile)

$SecretKeys = @('DB_PASSWORD', 'CREDENTIALS_KEY', 'CRON_SECRET', 'OPENAI_API_KEY', 'MAILCHIMP_API_KEY', 'MAILCHIMP_TRANSACTIONAL_API_KEY', 'TELEGRAM_BOT_TOKEN')
# Variables que define este script o la imagen; si vienen en el archivo se ignoran.
$ManagedKeys = @('NODE_ENV', 'HOST', 'PORT', 'DB_HOST', 'DB_SSL_MODE', 'DB_SSL_CA_FILE', 'DB_SSL_SERVERNAME', 'DATABASE_URL', 'TEST_DB_NAME', 'TEST_DATABASE_URL',
  'DEV_OPERATOR_TOKEN', 'BACKGROUND_JOBS', 'COOKIE_SECURE')
$script:Masks = @()

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }

function Read-EnvFile([string]$Path) {
  $values = [ordered]@{}
  foreach ($line in [IO.File]::ReadAllLines((Resolve-Path $Path), [Text.Encoding]::UTF8)) {
    if ($line -cmatch '^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$') {
      $key = $Matches[1]; $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
      if ($value -ne '') { $values[$key] = $value }
    }
  }
  return $values
}

function Format-Args([string[]]$GcloudArgs) {
  $text = $GcloudArgs -join ' '
  foreach ($mask in $script:Masks) { $text = $text.Replace($mask, '***') }
  return $text
}

# Ejecuta gcloud y se detiene si falla. Lo que gcloud escriba en su salida vuelve a quien llama.
function Invoke-Gcloud([string[]]$GcloudArgs) {
  Write-Host "  gcloud $(Format-Args $GcloudArgs)" -ForegroundColor DarkGray
  if ($DryRun) { return }
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & gcloud @GcloudArgs } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "gcloud termino con error ($LASTEXITCODE): gcloud $(Format-Args $GcloudArgs)" }
}

# Texto que devuelve un comando de gcloud, o $null si falla (sirve para preguntar "existe?").
function Get-GcloudText([string[]]$GcloudArgs) {
  if ($DryRun) { return $null }
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $output = & gcloud @GcloudArgs 2>$null } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { return $null }
  return (@($output) -join "`n")
}

# ---- 1. Variables ----
Write-Step "Variables de $EnvFile"
if (-not (Test-Path $EnvFile)) { throw "No existe $EnvFile. Copia deploy\cloud-run\env.example como $EnvFile (en la raiz del backend) y rellena los valores." }
if ($SqlInstance -notmatch '^[^:\s]+:[^:\s]+:[^:\s]+$') { throw '-SqlInstance debe tener la forma PROYECTO:REGION:INSTANCIA.' }
$envValues = Read-EnvFile $EnvFile

$missing = @('DB_NAME', 'DB_USER', 'DB_PASSWORD', 'FRONTEND_ORIGIN', 'CREDENTIALS_KEY', 'CRON_SECRET' | Where-Object { -not $envValues.Contains($_) })
if ($missing.Count -gt 0) { throw "Faltan valores en ${EnvFile}: $($missing -join ', ')" }
if ($envValues['CRON_SECRET'] -cnotmatch '^[A-Za-z0-9_-]{32,}$') { throw 'CRON_SECRET debe tener al menos 32 caracteres y solo letras, numeros, guion o guion bajo. Genera una: node -e "console.log(require(''crypto'').randomBytes(24).toString(''hex''))"' }
if ($envValues['FRONTEND_ORIGIN'] -notmatch '^https://[^/\s]+$') { throw 'FRONTEND_ORIGIN debe ser el origen https exacto de la web, sin ruta ni barra final (ejemplo: https://academic-hub.vercel.app).' }
$ignored = @($ManagedKeys | Where-Object { $envValues.Contains($_) })
if ($ignored.Count -gt 0) { Write-Host "  Se ignoran (las define el despliegue): $($ignored -join ', ')" -ForegroundColor Yellow }

$cron = $envValues['CRON_SECRET']
$script:Masks = @($cron)

$plain = [ordered]@{}
foreach ($key in $envValues.Keys) { if (($SecretKeys -notcontains $key) -and ($ManagedKeys -notcontains $key)) { $plain[$key] = $envValues[$key] } }
$plain['NODE_ENV'] = 'production'
$plain['DB_HOST'] = "/cloudsql/$SqlInstance"       # socket del conector de Cloud SQL: sin IP ni certificado
$plain['BACKGROUND_JOBS'] = 'false'                # las rutinas las dispara Cloud Scheduler con /jobs/tick; Telegram llega por webhook
$plain['COOKIE_SECURE'] = 'true'
Write-Host "  Variables normales: $($plain.Keys -join ', ')"
Write-Host "  Claves (Secret Manager): $(@($SecretKeys | Where-Object { $envValues.Contains($_) }) -join ', ')"

if (-not $DryRun) {
  if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'No se encuentra gcloud. Instala Google Cloud CLI (https://cloud.google.com/sdk/docs/install), abre una terminal nueva y ejecuta: gcloud auth login' }
}

# ---- 2. Servicios de Google Cloud y cuenta de servicio ----
Write-Step 'Servicios de Google Cloud'
Invoke-Gcloud @('services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com',
  'cloudscheduler.googleapis.com', 'sqladmin.googleapis.com', '--project', $Project)

Write-Step 'Cuenta de servicio de la API'
$accountName = 'academic-hub-run'
$account = "$accountName@$Project.iam.gserviceaccount.com"
if ($null -eq (Get-GcloudText @('iam', 'service-accounts', 'describe', $account, '--project', $Project))) {
  Invoke-Gcloud @('iam', 'service-accounts', 'create', $accountName, '--display-name', 'Academic Hub (Cloud Run)', '--project', $Project)
  if (-not $DryRun) { Start-Sleep -Seconds 8 }      # la cuenta tarda unos segundos en poder recibir permisos
} else { Write-Host "  $account ya existe" }
$sqlProject = $SqlInstance.Split(':')[0]
Invoke-Gcloud @('projects', 'add-iam-policy-binding', $sqlProject, '--member', "serviceAccount:$account", '--role', 'roles/cloudsql.client', '--condition', 'None', '--format', 'none', '--quiet')
Invoke-Gcloud @('projects', 'add-iam-policy-binding', $Project, '--member', "serviceAccount:$account", '--role', 'roles/secretmanager.secretAccessor', '--condition', 'None', '--format', 'none', '--quiet')

# ---- 3. Claves en Secret Manager ----
Write-Step 'Claves en Secret Manager'
$secretRefs = @()
foreach ($key in $SecretKeys) {
  if (-not $envValues.Contains($key)) { continue }
  $name = 'academic-hub-' + $key.ToLower().Replace('_', '-')
  $secretRefs += "$key=${name}:latest"
  if ($DryRun) { Write-Host "  $name <- $key (valor oculto)"; continue }
  $value = [string]$envValues[$key]
  if ($null -ne (Get-GcloudText @('secrets', 'describe', $name, '--project', $Project))) {
    if ((Get-GcloudText @('secrets', 'versions', 'access', 'latest', '--secret', $name, '--project', $Project)) -ceq $value) { Write-Host "  $name sin cambios"; continue }
    $action = @('secrets', 'versions', 'add', $name)
  } else {
    $action = @('secrets', 'create', $name, '--replication-policy', 'automatic')
  }
  # El valor viaja en un archivo temporal sin salto de linea final (un salto de linea de mas rompe, por ejemplo, la clave de la base).
  $temp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($temp, $value, (New-Object Text.UTF8Encoding($false)))
    Invoke-Gcloud ($action + @('--data-file', $temp, '--project', $Project)) | Out-Null
  } finally { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
}

# ---- 4. Construir y desplegar ----
Write-Step 'Construir la imagen y desplegar en Cloud Run (la primera vez tarda varios minutos)'
$yamlPath = Join-Path ([IO.Path]::GetTempPath()) "academic-hub-env-$PID.yaml"
$yaml = foreach ($key in $plain.Keys) { '{0}: "{1}"' -f $key, (([string]$plain[$key]) -replace '\\', '\\' -replace '"', '\"') }
[IO.File]::WriteAllLines($yamlPath, [string[]]$yaml, (New-Object Text.UTF8Encoding($false)))
try {
  Invoke-Gcloud @('run', 'deploy', $Service, '--source', '.', '--project', $Project, '--region', $Region, '--service-account', $account, '--allow-unauthenticated',
    '--execution-environment', 'gen2', '--cpu', '1', '--memory', '2Gi', '--cpu-boost',
    # timeout: una actualizacion completa con guias y tareas se atiende dentro de una sola peticion a /jobs/tick.
    # max-instances 1: el avance de una actualizacion vive en la memoria del servidor; con una sola instancia siempre se consulta la misma.
    '--timeout', '3600', '--concurrency', '40', '--min-instances', '0', '--max-instances', '1',
    '--set-cloudsql-instances', $SqlInstance, '--env-vars-file', $yamlPath, '--set-secrets', ($secretRefs -join ','), '--quiet')
} finally { Remove-Item $yamlPath -Force -ErrorAction SilentlyContinue }

$url = 'https://DIRECCION-DEL-SERVICIO.run.app'
if (-not $DryRun) {
  $url = ([string](Get-GcloudText @('run', 'services', 'describe', $Service, '--project', $Project, '--region', $Region, '--format', 'value(status.url)'))).Trim()
  if ($url -notmatch '^https://') { throw 'El servicio se desplego pero no se pudo leer su direccion. Revisa la consola de Cloud Run.' }
}
Write-Host "  API: $url" -ForegroundColor Green

# ---- 5. Cloud Scheduler: el unico disparador de las rutinas ----
Write-Step "Cloud Scheduler -> GET /jobs/tick ($TickSchedule)"
$jobName = 'academic-hub-tick'
$jobArgs = @('--location', $Region, '--project', $Project, '--schedule', $TickSchedule, '--time-zone', 'America/El_Salvador', '--uri', "$url/jobs/tick",
  '--http-method', 'GET', '--attempt-deadline', '1800s', '--max-retry-attempts', '0')
if ($null -ne (Get-GcloudText @('scheduler', 'jobs', 'describe', $jobName, '--location', $Region, '--project', $Project))) {
  Invoke-Gcloud (@('scheduler', 'jobs', 'update', 'http', $jobName) + $jobArgs + @('--update-headers', "Authorization=Bearer $cron")) | Out-Null
} else {
  Invoke-Gcloud (@('scheduler', 'jobs', 'create', 'http', $jobName) + $jobArgs + @('--headers', "Authorization=Bearer $cron")) | Out-Null
}

# ---- 6. Telegram por webhook y comprobacion ----
if ($envValues.Contains('TELEGRAM_BOT_TOKEN')) {
  Write-Step 'Webhook de Telegram'
  Write-Host "  POST $url/jobs/telegram/webhook" -ForegroundColor DarkGray
  if (-not $DryRun) {
    try {
      $answer = Invoke-RestMethod -Method Post -Uri "$url/jobs/telegram/webhook" -Headers @{ Authorization = "Bearer $cron" } -ContentType 'application/json' -Body ('{"baseUrl":"' + $url + '"}')
      Write-Host "  Telegram avisara a $($answer.webhook)"
    } catch { Write-Host "  No se pudo registrar el webhook: $($_.Exception.Message). Repite el script cuando la API responda." -ForegroundColor Yellow }
  }
}

Write-Step 'Comprobacion'
if ($DryRun) {
  Write-Host '  (simulacion: no se toco nada)'
} else {
  try { $health = Invoke-RestMethod -Uri "$url/health/db" -TimeoutSec 60; Write-Host "  Base de datos: $($health.database) ($($health.latencyMs) ms)" -ForegroundColor Green }
  catch { Write-Host "  /health/db no respondio bien: $($_.Exception.Message). Mira los registros: gcloud run services logs read $Service --project $Project --region $Region --limit 50" -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'Listo. Lo que falta por tu cuenta:' -ForegroundColor Green
Write-Host "  1. Web: en academic-hub-frontend\vercel.json cambia REEMPLAZA-CON-TU-DOMINIO-DE-LA-API por $($url -replace '^https://', '') y despliega en Vercel."
Write-Host "  2. FRONTEND_ORIGIN en $EnvFile debe ser la direccion exacta de esa web; si la cambias, vuelve a ejecutar este script."
Write-Host '  3. En tu computadora pon BACKGROUND_JOBS=false en .env: con el webhook activo, Telegram ya no acepta que tu PC lo consulte.'
Write-Host "  4. Probar las rutinas ahora:  gcloud scheduler jobs run $jobName --location $Region --project $Project"
