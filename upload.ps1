# Upload HT626 to Arduino Leonardo
# Usage: .\upload.ps1 [COM_PORT]
# Example: .\upload.ps1 COM3
$ErrorActionPreference = "Stop"

# Refresh PATH (terminals opened before install may miss arduino-cli)
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$cli = Get-Command arduino-cli -ErrorAction SilentlyContinue
if (-not $cli) {
  $fallback = "C:\Program Files\Arduino CLI\arduino-cli.exe"
  if (Test-Path $fallback) {
    $cliPath = $fallback
  } else {
    throw "arduino-cli not found. Install with: winget install ArduinoSA.CLI"
  }
} else {
  $cliPath = $cli.Source
}

$sketch = Join-Path $PSScriptRoot "HT626"
$build  = Join-Path $PSScriptRoot "build"
$port   = $args[0]

if (-not $port) {
  Write-Host "Connected boards:"
  & $cliPath board list
  Write-Host ""
  Write-Host "Usage: .\upload.ps1 COMx"
  exit 1
}

& $cliPath compile --fqbn arduino:avr:leonardo --build-path $build $sketch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Leonardo uses a 1200-baud touch to enter bootloader; CLI handles this
& $cliPath upload --fqbn arduino:avr:leonardo --port $port --input-dir $build $sketch
