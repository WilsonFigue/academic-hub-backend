<#
.SYNOPSIS
  Dispara a mano una rutina de la API desplegada (Cloud Run), con la clave CRON_SECRET de .env.cloudrun. Espera a que termine y muestra el resultado.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\cloud-run\run-job.ps1 -Url https://academic-hub-api-xxxx.run.app
  Corre "actualizar": Blackboard -> calendario -> guias -> tareas -> avisos y Telegram. Puede tardar varios minutos.

.EXAMPLE
  ... -Job correo-semanal      (tambien: correo-mensual, correo-diario)
  ... -Job tick                (lo mismo que hace Cloud Scheduler cada 5 minutos: solo lo que toque por horario)
  ... -Job historial           (las ultimas rutinas que corrieron, con su estado)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Job = 'actualizar',
  [string]$EnvFile = '.env.cloudrun'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location (Join-Path $PSScriptRoot '..\..')

$line = Get-Content $EnvFile | Where-Object { $_ -cmatch '^\s*CRON_SECRET\s*=' } | Select-Object -First 1
if (-not $line) { throw "Falta CRON_SECRET en $EnvFile." }
$secret = ($line -replace '^\s*CRON_SECRET\s*=', '').Trim().Trim('"').Trim("'")
$headers = @{ Authorization = "Bearer $secret" }
$base = $Url.TrimEnd('/')

if ($Job -eq 'historial') { $path = '/jobs/scheduler' }
elseif ($Job -eq 'tick') { $path = '/jobs/tick' }
else { $path = "/jobs/run?job=$Job" }

# GET: las rutinas aceptan GET y POST, y un GET no lleva cuerpo ni tipo de contenido que la API pueda rechazar.
Write-Host "GET $base$path  (espera a que termine...)"
Invoke-RestMethod -Method Get -Uri "$base$path" -Headers $headers -TimeoutSec 3600 | ConvertTo-Json -Depth 8
