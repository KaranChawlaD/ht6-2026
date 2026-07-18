# One-shot Leonardo recovery upload (minimal typing).
# Double-click this in Explorer, or run:  powershell -File .\recover-upload.ps1
#
# Steps printed on screen — use the mouse. Unplug the board first if keys are spam.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  "1) UNPLUG the Leonardo USB cable (stops key spam).`n" +
  "2) Click OK.`n" +
  "3) When asked, plug the board back in and DOUBLE-TAP RESET.",
  "HT626 recover upload",
  "OK",
  "Information"
) | Out-Null

& "$PSScriptRoot\upload.ps1" -ManualReset

if ($LASTEXITCODE -eq 0) {
  [System.Windows.Forms.MessageBox]::Show(
    "Upload OK.`n`nKeyboard stays OFF until you connect digital pin 2 to GND.",
    "HT626",
    "OK",
    "Information"
  ) | Out-Null
} else {
  [System.Windows.Forms.MessageBox]::Show(
    "Upload failed. Unplug, plug in, double-tap RESET faster, try again.",
    "HT626",
    "OK",
    "Error"
  ) | Out-Null
}
