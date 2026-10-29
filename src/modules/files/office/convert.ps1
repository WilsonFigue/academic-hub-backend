# Convierte un documento de Office a PDF con el Office instalado en este equipo (Word, PowerPoint o Excel), para verlo tal cual.
#
# Seguridad y respeto al usuario:
#  - Se abre en SOLO LECTURA, sin actualizar vínculos y sin tocar el documento original (se trabaja sobre una copia).
#  - Si Office ya estaba abierto con documentos del usuario y esta conversión se "pega" a esa misma instancia, NO se cambia ningún ajuste
#    de esa instancia (ventana, alertas, macros) y NO se cierra: solo se cierra el documento convertido. Con esa instancia compartida no se
#    convierten formatos antiguos (.doc/.ppt/.xls), que pueden llevar macros: se responde 'shared_instance_legacy' y la app usa su vista de texto.
#  - Si la instancia es nueva (solo de esta conversión), se abre sin ventana, con macros deshabilitadas y sin alertas, y se cierra al terminar.
param(
  [Parameter(Mandatory = $true)][ValidateSet('word', 'powerpoint', 'excel')][string]$Kind,
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Legacy
)
$ErrorActionPreference = 'Stop'
$In = (Resolve-Path -LiteralPath $In).Path
$processName = @{ word = 'WINWORD'; powerpoint = 'POWERPNT'; excel = 'EXCEL' }[$Kind]
$before = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$app = $null
$doc = $null
$ours = $false
$ourPids = @()
try {
  $progId = @{ word = 'Word.Application'; powerpoint = 'PowerPoint.Application'; excel = 'Excel.Application' }[$Kind]
  $app = New-Object -ComObject $progId
  Start-Sleep -Milliseconds 400
  $after = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $ourPids = @($after | Where-Object { $before -notcontains $_ })
  $ours = $ourPids.Count -gt 0
  if (-not $ours -and $Legacy) { throw 'shared_instance_legacy' }
  if ($ours) {
    if ($Kind -ne 'powerpoint') { $app.Visible = $false; $app.DisplayAlerts = $(if ($Kind -eq 'word') { 0 } else { $false }) }
    $app.AutomationSecurity = 3   # msoAutomationSecurityForceDisable
  }
  switch ($Kind) {
    'word' {
      $doc = $app.Documents.Open($In, $false, $true, $false)   # sin confirmar conversiones, solo lectura, sin "recientes"
      $doc.ExportAsFixedFormat($Out, 17)                       # wdExportFormatPDF
      $doc.Close($false)
    }
    'powerpoint' {
      $doc = $app.Presentations.Open($In, -1, 0, 0)            # solo lectura, sin título, sin ventana
      $doc.SaveAs($Out, 32)                                    # ppSaveAsPDF
      $doc.Close()
    }
    'excel' {
      $doc = $app.Workbooks.Open($In, 0, $true)                # sin actualizar vínculos, solo lectura
      $doc.ExportAsFixedFormat(0, $Out)                        # xlTypePDF
      $doc.Close($false)
    }
  }
  $doc = $null
  if (-not (Test-Path -LiteralPath $Out) -or (Get-Item -LiteralPath $Out).Length -eq 0) { throw 'La conversión no produjo un PDF.' }
}
finally {
  # Si algo falló con el documento abierto, se cierra sin guardar (solo ese documento).
  if ($doc -ne $null) { try { if ($Kind -eq 'powerpoint') { $doc.Close() } else { $doc.Close($false) } } catch { } }
  try {
    if ($app -ne $null -and $ours) {
      $open = switch ($Kind) { 'word' { $app.Documents.Count } 'powerpoint' { $app.Presentations.Count } 'excel' { $app.Workbooks.Count } }
      if ($open -eq 0) { $app.Quit() }
    }
  } catch { }
  if ($app -ne $null) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { } }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  # Red de seguridad: si la instancia que creó esta conversión no termina sola, se cierra (solo procesos nuevos de esta ejecución).
  foreach ($id in $ourPids) {
    try { $p = Get-Process -Id $id -ErrorAction Stop; if (-not $p.WaitForExit(8000)) { Stop-Process -Id $id -Force } } catch { }
  }
}
