# Compile HT626 for Arduino Leonardo
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

& $cliPath compile --fqbn arduino:avr:leonardo --build-path $build $sketch
if ($LASTEXITCODE -eq 0) {
  Write-Host "Build OK -> $build"
}
