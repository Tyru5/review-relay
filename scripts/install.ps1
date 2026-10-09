<#
.SYNOPSIS
  Install the review-relay binary on Windows from the GitHub Releases of Tyru5/review-relay.

.DESCRIPTION
    irm https://github.com/Tyru5/review-relay/releases/latest/download/install.ps1 | iex

  With options:
    & ([scriptblock]::Create((irm https://github.com/Tyru5/review-relay/releases/latest/download/install.ps1))) -Version 0.9.0 -NoModifyPath -NoAlias

  Env equivalents: REVIEW_RELAY_INSTALL_{VERSION,BIN_DIR,REPO,NO_MODIFY_PATH,NO_ALIAS}, REVIEW_RELAY_CONFIG
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$BinDir = '',
    [switch]$NoModifyPath,
    [switch]$NoAlias
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

$Repo = Get-Setting '' 'REVIEW_RELAY_INSTALL_REPO' 'Tyru5/review-relay'
$BaseUrl = "https://github.com/$Repo/releases"
$Version = Get-Setting $Version 'REVIEW_RELAY_INSTALL_VERSION' 'latest'
$BinDir = Get-Setting $BinDir 'REVIEW_RELAY_INSTALL_BIN_DIR' (Join-Path $env:LOCALAPPDATA 'review-relay\bin')
$Config = Get-Setting '' 'REVIEW_RELAY_CONFIG' (Join-Path $HOME '.review-relay\config.json')
$NoModifyPath = $NoModifyPath -or [bool]$env:REVIEW_RELAY_INSTALL_NO_MODIFY_PATH
$NoAlias = $NoAlias -or [bool]$env:REVIEW_RELAY_INSTALL_NO_ALIAS
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

# GitHub answers /releases/latest with a redirect to /releases/tag/<tag>; the tag is the version.
function Get-LatestVersion {
    try {
        $request = [Net.WebRequest]::CreateHttp("$BaseUrl/latest")
        $request.Method = 'HEAD'
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try { $location = [string]$response.Headers['Location'] } finally { $response.Close() }
    } catch {
        Fail "could not reach $BaseUrl ($($_.Exception.Message))"
    }
    if ($location -notmatch '/releases/tag/([^/?#]+)') { Fail "could not find the latest release at $BaseUrl" }
    return $Matches[1]
}

function Resolve-Version {
    $v = $Version
    if ($v -eq 'latest') { $v = Get-LatestVersion }
    $v = $v.Trim() -replace '^v', ''
    if ($v -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { Fail "invalid version: $v" }
    return $v
}

function Install-Binary([string]$Ver) {
    $url = "$BaseUrl/download/v$Ver"
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

# `rr` is a hard link to the binary (a native exe, so Ctrl+C stays clean), falling back to a .cmd shim.
# Recreated on every install, since replacing review-relay.exe detaches the old link.
# A marker records that rr is ours; an rr.exe or rr.cmd without it is left alone.
function Install-Alias([string]$Exe) {
    $link = Join-Path $BinDir 'rr.exe'
    $shim = Join-Path $BinDir 'rr.cmd'
    $marker = Join-Path $BinDir '.rr-alias'
    if (-not (Test-Path $marker) -and ((Test-Path $link) -or (Test-Path $shim))) {
        Write-Warn "skipped rr shortcut: rr already exists in $BinDir"
        return $false
    }
    try {
        Remove-Item -Force -ErrorAction SilentlyContinue $shim
        if (Test-Path $link) { Remove-Item -Force $link }
    } catch {
        Write-Warn "could not replace $link; stop any running rr and rerun"
        return $false
    }
    try {
        New-Item -ItemType HardLink -Path $link -Target $Exe | Out-Null
    } catch {
        Set-Content -Encoding Ascii -Path $shim -Value '@"%~dp0review-relay.exe" %*'
    }
    Set-Content -Path $marker -Value 'rr is managed by the review-relay installer'
    Write-Ok 'rr -> review-relay'
    return $true
}

function Initialize-Config([string]$Ver) {
    if (Test-Path $Config) { Write-Ok "keeping existing config $Config"; return }
    New-Item -ItemType Directory -Force -Path (Split-Path $Config -Parent) | Out-Null
    Save-Url "$BaseUrl/download/v$Ver/config.example.json" $Config
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
        Fail "this installer is for Windows; on macOS/Linux run: curl -fsSL $BaseUrl/latest/download/install.sh | bash"
    }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Write-Info 'ARM64 Windows: installing the x64 build (runs under emulation)' }

    $ver = Resolve-Version
    Write-Info "downloading review-relay $ver (windows-x64)"
    $exe = Install-Binary $ver

    $installed = Invoke-Probe $exe --version
    if ($LASTEXITCODE -ne 0 -or -not $installed) { Fail "installed, but '$exe --version' failed" }
    Write-Ok "review-relay $installed installed to $exe"

    Initialize-Config $ver
    $aliasHint = if (-not $NoAlias -and (Install-Alias $exe)) { "`n  rr is short for review-relay" } else { '' }
    Add-ToPath
    Show-RuntimeDeps
    # A daemon started before this install keeps running the old build until it restarts.
    $daemon = Get-CimInstance Win32_Process -Filter "Name = 'review-relay.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '\bstart\b' }
    if ($daemon) { Write-Warn 'a review-relay daemon is still running the previous build; run: review-relay restart' }

    Write-Host @"

Next
  review-relay setup        # pick repos, reviewers, and models (or notepad $Config)
  review-relay start        # watch configured repos
  review-relay status       # recent jobs$aliasHint
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
