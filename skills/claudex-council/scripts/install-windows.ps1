#requires -Version 5.1
<#
Installs Claudex Council from a cloned repo on Windows.

Run from PowerShell:
  powershell -ExecutionPolicy Bypass -File .\skills\claudex-council\scripts\install-windows.ps1

What it automates:
  - finds or installs per-user Node.js and Python
  - installs Claude Code and Codex CLIs through npm
  - builds and packages the VS Code extension
  - installs the VSIX into VS Code
  - pins binary paths in VS Code settings so Dock/Start-menu PATH issues do not matter

It cannot complete Claude/Codex account login for you. Those remain interactive.
#>

[CmdletBinding()]
param(
  [switch]$SkipCliInstall,
  [switch]$SkipVsixInstall,
  [switch]$SkipSettingsPatch,
  [switch]$CheckOnly,
  [string]$NodeVersion = "v22.11.0",
  [string]$PythonVersion = "3.12.7"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Step($message) {
  Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Add-PathDir([string]$dir) {
  if (-not $dir -or -not (Test-Path $dir)) { return }
  $parts = ($env:PATH -split ";") | Where-Object { $_ }
  if ($parts -notcontains $dir) {
    $env:PATH = "$dir;$env:PATH"
  }
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $userParts = $userPath -split ";" | Where-Object { $_ }
  if ($userParts -notcontains $dir -and -not $CheckOnly) {
    [Environment]::SetEnvironmentVariable("Path", "$dir;$userPath", "User")
  }
}

function Find-CommandPath([string[]]$names) {
  foreach ($name in $names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
  }
  return $null
}

function Invoke-Logged([string]$exe, [string[]]$args, [string]$cwd = "") {
  $old = Get-Location
  try {
    if ($cwd) { Set-Location $cwd }
    Write-Host ("$exe " + ($args -join " ")) -ForegroundColor DarkGray
    & $exe @args
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code $LASTEXITCODE`: $exe $($args -join ' ')"
    }
  } finally {
    Set-Location $old
  }
}

function Download-File([string]$url, [string]$outFile) {
  if ($CheckOnly) {
    Write-Host "Would download $url -> $outFile"
    return
  }
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
}

function Ensure-Node {
  Step "Checking Node.js"
  $node = Find-CommandPath @("node.exe", "node")
  $npm = Find-CommandPath @("npm.cmd", "npm")
  if ($node -and $npm) {
    Write-Host "Found Node: $node"
    Write-Host "Found npm:  $npm"
    return @{ Node = $node; Npm = $npm; Npx = (Find-CommandPath @("npx.cmd", "npx")) }
  }

  $tools = Join-Path $env:USERPROFILE "Tools"
  $nodeDir = Join-Path $tools "nodejs"
  $nodeZip = Join-Path $tools "node.zip"
  $nodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
  if ($CheckOnly) {
    Write-Host "Node/npm not found. Would install portable Node $NodeVersion to $nodeDir."
    return @{ Node = (Join-Path $nodeDir "node.exe"); Npm = (Join-Path $nodeDir "npm.cmd"); Npx = (Join-Path $nodeDir "npx.cmd") }
  }

  New-Item -ItemType Directory -Path $tools -Force | Out-Null
  Download-File $nodeUrl $nodeZip
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Expand-Archive -Path $nodeZip -DestinationPath $tools -Force
  $expanded = Get-ChildItem $tools -Directory | Where-Object { $_.Name -eq "node-$NodeVersion-win-x64" } | Select-Object -First 1
  if (-not $expanded) { throw "Could not find extracted Node directory." }
  Rename-Item -Path $expanded.FullName -NewName "nodejs" -Force
  Add-PathDir $nodeDir
  return @{ Node = (Join-Path $nodeDir "node.exe"); Npm = (Join-Path $nodeDir "npm.cmd"); Npx = (Join-Path $nodeDir "npx.cmd") }
}

function Ensure-Python {
  Step "Checking Python"
  $python = Find-CommandPath @("python.exe", "python")
  if ($python) {
    Write-Host "Found Python: $python"
    return $python
  }

  $tools = Join-Path $env:USERPROFILE "Tools"
  $pythonDir = Join-Path $tools "python312"
  $installer = Join-Path $tools "python-installer.exe"
  $pythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
  if ($CheckOnly) {
    Write-Host "Python not found. Would install Python $PythonVersion to $pythonDir."
    return (Join-Path $pythonDir "python.exe")
  }

  New-Item -ItemType Directory -Path $tools -Force | Out-Null
  Download-File $pythonUrl $installer
  $args = @(
    "/quiet",
    "InstallAllUsers=0",
    "PrependPath=1",
    "Include_pip=1",
    "Include_test=0",
    "Include_doc=0",
    "Include_launcher=0",
    "SimpleInstall=1",
    "TargetDir=$pythonDir"
  )
  $p = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0) { throw "Python installer failed with exit code $($p.ExitCode)." }
  Add-PathDir $pythonDir
  Add-PathDir (Join-Path $pythonDir "Scripts")
  return (Join-Path $pythonDir "python.exe")
}

function Update-VsCodeSettings([string]$claudeCmd, [string]$codexCmd, [string]$pythonExe) {
  if ($SkipSettingsPatch) { return }
  Step "Pinning Claudex Council binary paths in VS Code settings"
  $settingsPath = Join-Path $env:APPDATA "Code\User\settings.json"
  if ($CheckOnly) {
    Write-Host "Would update $settingsPath"
    return
  }
  $settingsDir = Split-Path -Parent $settingsPath
  New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
  if (Test-Path $settingsPath) {
    try {
      $json = Get-Content -Raw $settingsPath | ConvertFrom-Json
    } catch {
      Write-Warning "Could not parse $settingsPath as JSON. Skipping settings patch."
      return
    }
  } else {
    $json = [pscustomobject]@{}
  }

  $json | Add-Member -NotePropertyName "claudexCouncil.claudeBinary" -NotePropertyValue $claudeCmd -Force
  $json | Add-Member -NotePropertyName "claudexCouncil.codexBinary" -NotePropertyValue $codexCmd -Force
  $json | Add-Member -NotePropertyName "claudexCouncil.pythonBinary" -NotePropertyValue $pythonExe -Force
  $json | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding UTF8
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillDir = Resolve-Path (Join-Path $scriptDir "..")
$repoRoot = Resolve-Path (Join-Path $skillDir "..\..")
$extensionDir = Join-Path $skillDir "extension"
$npmGlobal = Join-Path $env:APPDATA "npm"

Step "Preparing paths"
New-Item -ItemType Directory -Path $npmGlobal -Force | Out-Null
Add-PathDir $npmGlobal
$toolsNode = Join-Path $env:USERPROFILE "Tools\nodejs"
if (Test-Path $toolsNode) { Add-PathDir $toolsNode }

$nodeTools = Ensure-Node
Add-PathDir (Split-Path -Parent $nodeTools.Node)
$pythonExe = Ensure-Python
Add-PathDir (Split-Path -Parent $pythonExe)

if ($CheckOnly) {
  Write-Host ""
  Write-Host "Check-only mode complete. Re-run without -CheckOnly to install/build." -ForegroundColor Green
  exit 0
}

Step "Configuring npm global prefix"
Invoke-Logged $nodeTools.Npm @("config", "set", "prefix", $npmGlobal, "--global")
Add-PathDir $npmGlobal

if (-not $SkipCliInstall) {
  Step "Installing Claude Code and Codex CLIs"
  Invoke-Logged $nodeTools.Npm @("install", "-g", "@anthropic-ai/claude-code")
  Invoke-Logged $nodeTools.Npm @("install", "-g", "@openai/codex")
}

$claudeCmd = Join-Path $npmGlobal "claude.cmd"
$codexCmd = Join-Path $npmGlobal "codex.cmd"
if (Test-Path $nodeTools.Node) {
  Copy-Item -Path $nodeTools.Node -Destination (Join-Path $npmGlobal "node.exe") -Force
}

Update-VsCodeSettings $claudeCmd $codexCmd $pythonExe

Step "Building the extension"
Invoke-Logged $nodeTools.Npm @("install") $extensionDir
Invoke-Logged (Join-Path (Split-Path -Parent $nodeTools.Npm) "npx.cmd") @("tsc", "-p", "./") $extensionDir
Invoke-Logged (Join-Path (Split-Path -Parent $nodeTools.Npm) "npx.cmd") @("--yes", "@vscode/vsce", "package", "--out", "claudex-council.vsix", "--allow-missing-repository", "--skip-license") $extensionDir

if (-not $SkipVsixInstall) {
  Step "Installing VSIX into VS Code"
  $code = Find-CommandPath @("code.cmd", "code")
  if (-not $code) {
    Write-Warning "VS Code CLI was not found. Install the VSIX manually from $extensionDir\claudex-council.vsix"
  } else {
    Invoke-Logged $code @("--install-extension", (Join-Path $extensionDir "claudex-council.vsix"), "--force")
  }
}

Step "Auth status"
if (Test-Path $claudeCmd) {
  & $claudeCmd auth status --text 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "Claude still needs login: claude login" -ForegroundColor Yellow }
}
if (Test-Path $codexCmd) {
  & $codexCmd login status 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "Codex still needs login: codex login" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "Done. Reload VS Code, then open Claudex Council from the activity bar." -ForegroundColor Green
Write-Host "For an end-to-end full-council check, use a substantive prompt or include 'full council' in the prompt."
