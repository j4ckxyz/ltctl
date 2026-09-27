# ltctl installer for Windows.
#
#   irm https://raw.githubusercontent.com/j4ckxyz/ltctl/main/install.ps1 | iex
#
# Run it from an elevated PowerShell (Run as administrator) to install for all users in
# "C:\Program Files\ltctl" and add it to the system PATH. From a normal PowerShell it installs
# for you only, in "%LOCALAPPDATA%\Programs\ltctl", and adds it to your user PATH.
#
# Options (environment variables):
#   $env:LTCTL_VERSION = "v1.0.0"       install a specific release (default: latest)
#   $env:LTCTL_INSTALL_DIR = "D:\tools"  install somewhere else
#   $env:LTCTL_UNINSTALL = "1"           remove ltctl instead

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "j4ckxyz/ltctl"
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
$Scope = if ($IsAdmin) { "Machine" } else { "User" }
$InstallDir = if ($env:LTCTL_INSTALL_DIR) { $env:LTCTL_INSTALL_DIR }
              elseif ($IsAdmin) { Join-Path $env:ProgramFiles "ltctl" }
              else { Join-Path $env:LOCALAPPDATA "Programs\ltctl" }
$Version = if ($env:LTCTL_VERSION) { $env:LTCTL_VERSION } else { "latest" }

function Update-Path([string]$Dir, [bool]$Add) {
  $current = [Environment]::GetEnvironmentVariable("Path", $Scope)
  $parts = @($current -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ne $Dir.TrimEnd("\")) })
  if ($Add) { $parts += $Dir }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), $Scope)
}

if ($env:LTCTL_UNINSTALL) {
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir; Write-Host "Removed $InstallDir" }
  Update-Path $InstallDir $false
  Write-Host "Your presets, backups and catalogue were left in place (see 'ltctl doctor' for where)."
  return
}

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { throw "Unsupported processor: $($env:PROCESSOR_ARCHITECTURE)" }
}
$Asset = "ltctl-windows-$Arch.zip"
$Base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" }
        else { "https://github.com/$Repo/releases/download/$Version" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("ltctl-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "Downloading $Asset ($Version)..."
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS")

  $Line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match "  $([Regex]::Escape($Asset))$" }
  if (-not $Line) { throw "$Asset is missing from SHA256SUMS" }
  $Expected = ($Line -split "\s+")[0].ToLower()
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $Asset)).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset (expected $Expected, got $Actual)" }

  Expand-Archive -Path (Join-Path $Tmp $Asset) -DestinationPath (Join-Path $Tmp "x") -Force
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Force (Join-Path $Tmp "x\*") $InstallDir
  Unblock-File (Join-Path $InstallDir "ltctl.exe")
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

Update-Path $InstallDir $true
if (-not (($env:Path -split ";") -contains $InstallDir)) { $env:Path = "$env:Path;$InstallDir" }

$Installed = & (Join-Path $InstallDir "ltctl.exe") --version
Write-Host ""
Write-Host "Installed $Installed to $InstallDir ($($Scope.ToLower()) PATH updated; open a new terminal to use it everywhere)."
Write-Host ""
Write-Host "Next:"
Write-Host "  ltctl setup <catalog.json>   install the amp and effect catalogue (made with 'ltctl setup' on a Mac)"
Write-Host "  ltctl doctor                 check that everything works"
Write-Host "  ltctl list                   list your amp's presets"
