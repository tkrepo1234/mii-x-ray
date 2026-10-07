<#
.SYNOPSIS
    X-Rays every transaction of an MII export folder and compiles each generated file with the C# 5 compiler of
    the .NET Framework. Every file must compile on its own.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\corpus-check.ps1 -ExportFolder C:\Claude\BLS\projects
#>
param(
    [Parameter(Mandatory = $true)][string]$ExportFolder,
    [string]$WorkFolder = (Join-Path $env:TEMP 'mii-x-ray-corpus-check')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'bin\MiiXRay.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $exe)) { throw "Build first: $exe is missing." }

if (Test-Path $WorkFolder) { Remove-Item -Recurse -Force $WorkFolder }
$generated = Join-Path $WorkFolder 'generated'
$compiled = Join-Path $WorkFolder 'compiled'
New-Item -ItemType Directory -Force $generated, $compiled | Out-Null

& $exe --folder $ExportFolder --all --out $generated | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning 'X-Ray reported failures (see above).' }

$files = @(Get-ChildItem -Recurse -Filter '*.xray.cs' $generated)
$failed = @()
$index = 0
foreach ($file in $files) {
    $index++
    $dll = Join-Path $compiled ("{0}_{1}.dll" -f $index, $file.BaseName)
    $output = & $csc -nologo -langversion:5 -warn:0 -target:library "-out:$dll" $file.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        $failed += [pscustomobject]@{ File = $file.FullName; Errors = ($output | Where-Object { $_ -match 'error' } | Select-Object -First 5) -join [Environment]::NewLine }
    }
}

Write-Host ("{0} generated, {1} compiled, {2} failed" -f $files.Count, ($files.Count - $failed.Count), $failed.Count)
foreach ($failure in $failed) {
    Write-Host ''
    Write-Host $failure.File -ForegroundColor Yellow
    Write-Host $failure.Errors
}
if ($failed.Count -gt 0) { exit 1 }
