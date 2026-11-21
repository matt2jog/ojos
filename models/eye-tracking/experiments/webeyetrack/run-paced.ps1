param(
  [Parameter(Mandatory)][string]$Run,
  [Parameter(Mandatory)][string]$AnalysisAssets,
  [Parameter(Mandatory)][string]$OriginalRecording,
  [ValidateSet('chrome','msedge')][string]$Browser = 'chrome',
  [switch]$ConfirmLoad
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$Run = (Resolve-Path -LiteralPath $Run).Path
$AnalysisAssets = (Resolve-Path -LiteralPath $AnalysisAssets).Path
$OriginalRecording = (Resolve-Path -LiteralPath $OriginalRecording).Path
node plans.mjs $Run
if ($ConfirmLoad) {
  $gazePlan = "$Run/load-check-plan.json"
  $gazeReport = "$Run/browser-load-check.json"
} else {
  node browser.mjs $Run "$Run/pace-plan.json" "$Run/browser-pace.json" $Browser
  try {
    node browser.mjs $Run "$Run/backends-plan.json" "$Run/browser-backends.json" $Browser
  } catch {
    Write-Host "One or more alternate runtime cases failed. See browser-backends.json."
  }
  $gazePlan = "$Run/load-plan.json"
  $gazeReport = "$Run/browser-load.json"
}
$gazeCore = Join-Path $AnalysisAssets 'core-venv/Scripts/python.exe'
$gazeReady = Join-Path $Run ([Guid]::NewGuid().ToString('N') + '.ready')
$gazeStop = "$gazeReady.stop"
$gazeLoad = Start-Process -PassThru -WindowStyle Hidden -FilePath $gazeCore -ArgumentList @(
  'confusion-load.py','--source',('"' + $AnalysisAssets + '"'),
  '--recording',('"' + $OriginalRecording + '"'),'--ready',('"' + $gazeReady + '"'),
  '--stop',('"' + $gazeStop + '"'),'--seconds','600'
) -RedirectStandardOutput "$gazeReport.confusion.log" -RedirectStandardError "$gazeReport.confusion-errors.log"
try {
  $gazeDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path -LiteralPath $gazeReady)) {
    if ($gazeLoad.HasExited -or [DateTime]::UtcNow -gt $gazeDeadline) {
      throw 'The ONNX confusion load did not initialize. See confusion-load-errors.log.'
    }
    Start-Sleep -Milliseconds 100
  }
  node browser.mjs $Run $gazePlan $gazeReport $Browser
} finally {
  [IO.File]::WriteAllText($gazeStop, 'stop')
  $null = $gazeLoad.WaitForExit(3000)
}
node score.mjs $Run
