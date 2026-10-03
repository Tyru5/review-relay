<#
.SYNOPSIS
  Install the review-relay binary on Windows.

.DESCRIPTION
    irm https://downloads.reviewrelay.dev/install.ps1 | iex

  With options:
    & ([scriptblock]::Create((irm https://downloads.reviewrelay.dev/install.ps1))) -Version 0.2.0 -NoModifyPath

  Env equivalents: REVIEW_RELAY_INSTALL_{VERSION,BIN_DIR,URL,NO_MODIFY_PATH}, REVIEW_RELAY_CONFIG
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$BinDir = '',
    [switch]$NoModifyPath
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 renders the download progress bar so slowly it dominates install time.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-Setting([string]$Value, [string]$EnvName, [string]$Default) {
    if ($Value) { return $Value }
    $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
    if ($fromEnv) { return $fromEnv }
    return $Default
}

$BaseUrl = Get-Setting '' 'REVIEW_RELAY_INSTALL_URL' 'https://downloads.reviewrelay.dev'
$Version = Get-Setting $Version 'REVIEW_RELAY_INSTALL_VERSION' 'latest'
$BinDir = Get-Setting $BinDir 'REVIEW_RELAY_INSTALL_BIN_DIR' (Join-Path $env:LOCALAPPDATA 'review-relay\bin')
$Config = Get-Setting '' 'REVIEW_RELAY_CONFIG' (Join-Path $HOME '.review-relay\config.json')
$NoModifyPath = $NoModifyPath -or [bool]$env:REVIEW_RELAY_INSTALL_NO_MODIFY_PATH
$Asset = 'review-relay-windows-x64.exe'

function Write-Info([string]$Message) { Write-Host '> ' -ForegroundColor White -NoNewline; Write-Host $Message }
function Write-Ok([string]$Message) { Write-Host '+ ' -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Warn([string]$Message) { Write-Host '! ' -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Fail([string]$Message) { throw $Message }
function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Save-Url([string]$Url, [string]$OutFile) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
    } catch {
        Fail "download failed: $Url ($($_.Exception.Message))"
    }
}

# Windows PowerShell 5.1 turns redirected native stderr into terminating errors under 'Stop'.
function Invoke-Probe {
    $ErrorActionPreference = 'Continue'
    $exe, $rest = $args
    & $exe $rest 2>$null
}

function Resolve-Version {
    $v = $Version
    if ($v -eq 'latest') {
        try { $v = [string](Invoke-RestMethod -UseBasicParsing -Uri "$BaseUrl/latest.txt") } catch { Fail "could not reach $BaseUrl" }
    }
    $v = $v.Trim() -replace '^v', ''
    if ($v -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { Fail "invalid version: $v" }
    return $v
}

function Install-Binary([string]$Ver) {
    $url = "$BaseUrl/v$Ver"
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $exe = Join-Path $BinDir 'review-relay.exe'
    $staged = "$exe.download"
    $sums = Join-Path ([IO.Path]::GetTempPath()) "review-relay-SHA256SUMS-$PID"
    try {
        Save-Url "$url/SHA256SUMS" $sums
        Save-Url "$url/$Asset" $staged

        $expected = Get-Content $sums | ForEach-Object {
            $hash, $name = -split $_
            if ($name -eq $Asset) { $hash }
        } | Select-Object -First 1
        if (-not $expected) { Fail "$Asset missing from SHA256SUMS" }
        if ((Get-FileHash -Algorithm SHA256 $staged).Hash -ne $expected) { Fail "checksum mismatch for $Asset; aborting" }

        try {
            Move-Item -Force $staged $exe
        } catch {
            Fail "could not replace $exe; stop any running review-relay and rerun"
        }
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $sums, $staged
    }
    return $exe
}

function Initialize-Config([string]$Ver) {
    if (Test-Path $Config) { Write-Ok "keeping existing config $Config"; return }
    New-Item -ItemType Directory -Force -Path (Split-Path $Config -Parent) | Out-Null
    Save-Url "$BaseUrl/v$Ver/config.example.json" $Config
    Write-Ok "wrote example config to $Config (edit repos before starting)"
}

function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = if ($userPath) { $userPath -split ';' } else { @() }
    if ($entries -notcontains $BinDir) {
        if ($NoModifyPath) {
            Write-Warn "$BinDir is not on PATH; add it to your user PATH"
        } else {
            [Environment]::SetEnvironmentVariable('Path', (($entries + $BinDir) | Where-Object { $_ }) -join ';', 'User')
            Write-Ok "added $BinDir to user PATH (new terminals pick it up)"
        }
    }
    if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }
}

function Show-RuntimeDeps {
    $missing = @()
    if (-not (Test-Command 'git')) { $missing += 'git (winget install Git.Git)' }
    if (-not (Test-Command 'gh')) {
        $missing += 'gh (winget install GitHub.cli), then: gh auth login'
    } elseif (-not ((Invoke-Probe gh extension list) -match 'gh-webhook')) {
        $missing += 'gh webhook extension: gh extension install cli/gh-webhook'
    }
    if (-not (Test-Command 'codex')) { $missing += 'codex CLI (signed in)' }
    if (-not (Test-Command 'claude')) { $missing += 'claude CLI (signed in)' }
    if ($missing.Count) {
        Write-Warn 'review-relay needs these at runtime:'
        $missing | ForEach-Object { Write-Host "    $_" }
    }
}

function Install-ReviewRelay {
    if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
        Fail "this installer is for Windows; on macOS/Linux run: curl -fsSL $BaseUrl/install.sh | bash"
    }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Write-Info 'ARM64 Windows: installing the x64 build (runs under emulation)' }

    $ver = Resolve-Version
    Write-Info "downloading review-relay $ver (windows-x64)"
    $exe = Install-Binary $ver

    $installed = Invoke-Probe $exe --version
    if ($LASTEXITCODE -ne 0 -or -not $installed) { Fail "installed, but '$exe --version' failed" }
    Write-Ok "review-relay $installed installed to $exe"

    Initialize-Config $ver
    Add-ToPath
    Show-RuntimeDeps

    Write-Host @"

Next
  review-relay setup        # pick repos, reviewers, and models (or notepad $Config)
  review-relay start        # watch configured repos
  review-relay status       # recent jobs
  rerun the installer to update
"@
}

# Under `| iex`, `exit` would close the caller's shell, so only exit non-zero when run as a file.
try {
    Install-ReviewRelay
} catch {
    Write-Host 'x ' -ForegroundColor Red -NoNewline
    Write-Host $_.Exception.Message
    if ($PSCommandPath) { exit 1 }
}
