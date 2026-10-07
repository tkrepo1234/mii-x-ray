<#
.SYNOPSIS
    X-Rays every transaction of an MII export folder and compiles each generated file as C# 12 against the .NET 8
    reference assemblies (Roslyn of an installed .NET SDK). Every file must compile on its own.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\corpus-check.ps1 -ExportFolder C:\Claude\BLS\projects
#>
param(
    [Parameter(Mandatory = $true)][string]$ExportFolder,
    [string]$WorkFolder = (Join-Path $env:TEMP 'mii-x-ray-corpus-check'),
    [string]$DotnetRoot = (Join-Path $env:ProgramFiles 'dotnet')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'bin\MiiXRay.exe'
if (-not (Test-Path $exe)) { throw "Build first: $exe is missing." }

$dotnet = Join-Path $DotnetRoot 'dotnet.exe'
$csc = Get-ChildItem (Join-Path $DotnetRoot 'sdk\*\Roslyn\bincore\csc.dll') | Sort-Object FullName | Select-Object -Last 1
$refs = Get-ChildItem (Join-Path $DotnetRoot 'packs\Microsoft.NETCore.App.Ref\8.*\ref\net8.0') | Sort-Object FullName | Select-Object -Last 1
if (-not $csc -or -not $refs) { throw "A .NET SDK with the .NET 8 reference pack is needed under $DotnetRoot." }

if (Test-Path $WorkFolder) { Remove-Item -Recurse -Force $WorkFolder }
$generated = Join-Path $WorkFolder 'generated'
$compiled = Join-Path $WorkFolder 'compiled'
New-Item -ItemType Directory -Force $generated, $compiled | Out-Null
$rsp = Join-Path $WorkFolder 'references.rsp'
Get-ChildItem (Join-Path $refs.FullName '*.dll') | ForEach-Object { '-r:"' + $_.FullName + '"' } | Set-Content -Encoding ASCII $rsp

& $exe --folder $ExportFolder --all --out $generated | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning 'X-Ray reported failures (see above).' }

$files = @(Get-ChildItem -Recurse -Filter '*.xray.cs' $generated)
$failed = @()
$index = 0
foreach ($file in $files) {
    $index++
    $dll = Join-Path $compiled ("{0}_{1}.dll" -f $index, $file.BaseName)
    $output = & $dotnet $csc.FullName -nologo -shared -langversion:12 -nostdlib -warn:0 -target:library "-out:$dll" "@$rsp" $file.FullName 2>&1
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
