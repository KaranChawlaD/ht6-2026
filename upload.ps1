# Upload HT626 to Arduino Leonardo
# Usage:
#   .\upload.ps1              # list ports + help
#   .\upload.ps1 COM10        # normal upload (1200-baud reset)
#   .\upload.ps1 -ManualReset # compile, then wait while you tap Reset
#
# Leonardo tip: Keyboard sketches often break auto-reset. If upload fails,
# use -ManualReset: double-tap Reset, then this script uploads to the new
# bootloader COM port (appears for about 8 seconds).

param(
  [Parameter(Position = 0)]
  [string]$Port,

  [switch]$ManualReset
)

$ErrorActionPreference = "Stop"

$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$cli = Get-Command arduino-cli -ErrorAction SilentlyContinue
if (-not $cli) {
  $fallback = "C:\Program Files\Arduino CLI\arduino-cli.exe"
  if (-not (Test-Path $fallback)) {
    throw "arduino-cli not found. Install with: winget install ArduinoSA.CLI"
  }
  $cliPath = $fallback
} else {
  $cliPath = $cli.Source
}

$sketch = Join-Path $PSScriptRoot "HT626"
$build  = Join-Path $PSScriptRoot "build"
$fqbn   = "arduino:avr:leonardo"

function Get-ComPorts {
  [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object
}

function Show-Ports {
  Write-Host "arduino-cli board list:"
  & $cliPath board list
  Write-Host ""
  Write-Host "Windows COM ports: $((Get-ComPorts) -join ', ')"
  Write-Host ""
  Get-CimInstance Win32_SerialPort |
    Select-Object DeviceID, Name, Description |
    Format-Table -AutoSize
}

if (-not $Port -and -not $ManualReset) {
  Show-Ports
  Write-Host "Usage:"
  Write-Host "  .\upload.ps1 COMx"
  Write-Host "  .\upload.ps1 -ManualReset"
  exit 1
}

Write-Host "Compiling..."
& $cliPath compile --fqbn $fqbn --build-path $build $sketch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($ManualReset) {
  $before = @(Get-ComPorts)
  Write-Host ""
  Write-Host "1) Unplug pots or center them so keys stop typing (if still on old firmware)."
  Write-Host "2) Double-tap the Leonardo RESET button (two quick presses)."
  Write-Host "3) A new COM port should appear for about 8 seconds (bootloader)."
  Write-Host ""
  Write-Host "Waiting for a new COM port (60s)..."
  Write-Host "Current ports: $($before -join ', ')"

  $bootPort = $null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $now = @(Get-ComPorts)
    $added = @($now | Where-Object { $_ -notin $before })
    if ($added.Count -ge 1) {
      $bootPort = $added[0]
      break
    }
  }

  if (-not $bootPort) {
    Write-Host "No new COM port appeared. Is the board plugged in via USB data cable?"
    Show-Ports
    exit 1
  }

  Write-Host "Bootloader port: $bootPort - uploading now..."
  & $cliPath upload --fqbn $fqbn --port $bootPort --input-dir $build $sketch
  exit $LASTEXITCODE
}

# Normal path: verify port exists first
$ports = @(Get-ComPorts)
if ($Port -notin $ports) {
  Write-Host "Port $Port is not present."
  Write-Host "Available: $($ports -join ', ')"
  Write-Host ""
  Write-Host "Keyboard sketches often leave Leonardo hard to auto-reset."
  Write-Host "Try:  .\upload.ps1 -ManualReset"
  Write-Host ""
  Show-Ports
  exit 1
}

Write-Host "Uploading to $Port (Leonardo auto-reset)..."
& $cliPath upload --fqbn $fqbn --port $Port --input-dir $build $sketch
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Auto-reset upload failed (common with Keyboard HID)."
  Write-Host "Retry with:  .\upload.ps1 -ManualReset"
  exit $LASTEXITCODE
}
