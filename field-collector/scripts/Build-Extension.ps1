[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$collectorRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $collectorRoot 'extension\src'
$adapterSource = Join-Path $collectorRoot 'injector\dist\collector.iife.js'
$adapterDevelopmentSource = Join-Path $collectorRoot 'injector\src\collector.ts'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $collectorRoot 'extension\dist'
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $collectorRoot 'extension'))
if (-not $outputRoot.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Extension output must remain below field-collector/extension.'
}

foreach ($required in @(
    'manifest.json',
    'popup.html',
    'popup.js',
    'modules\protocol.js',
    'modules\adapter-loader.js',
    'modules\command-policy.js',
    'service-worker.js',
    'styles.css'
)) {
    $path = Join-Path $sourceRoot $required
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing extension source file: $required"
    }
}
if (-not (Test-Path -LiteralPath $adapterSource -PathType Leaf)) {
    throw 'Missing built adapter.'
}
if (-not (Test-Path -LiteralPath $adapterDevelopmentSource -PathType Leaf)) {
    throw 'Missing adapter development source.'
}
$sourceHash = (Get-FileHash -LiteralPath $adapterDevelopmentSource -Algorithm SHA256).Hash
$adapterHash = (Get-FileHash -LiteralPath $adapterSource -Algorithm SHA256).Hash
if ($sourceHash -cne $adapterHash) {
    throw 'Adapter source and built IIFE differ.'
}

[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$adapterOutput = Join-Path $outputRoot 'adapter'
[System.IO.Directory]::CreateDirectory($adapterOutput) | Out-Null

foreach ($sourceName in @(
    'manifest.json',
    'popup.html',
    'popup.js',
    'styles.css'
)) {
    [System.IO.File]::Copy(
        (Join-Path $sourceRoot $sourceName),
        (Join-Path $outputRoot $sourceName),
        $true
    )
}
$workerModules = @(
    'modules\protocol.js',
    'modules\adapter-loader.js',
    'modules\command-policy.js',
    'service-worker.js'
)
$workerSource = [string]::Join("`n", @($workerModules | ForEach-Object {
    [System.IO.File]::ReadAllText((Join-Path $sourceRoot $_))
}))
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
    (Join-Path $outputRoot 'service-worker.js'),
    $workerSource.TrimEnd("`r", "`n") + "`n",
    $utf8
)
[System.IO.File]::Copy(
    $adapterSource,
    (Join-Path $adapterOutput 'collector.iife.js'),
    $true
)

$adapterManifest = [ordered]@{
    schemaVersion = 'wafc-adapter-manifest/1'
    adapterId = 'wa-private-collections-v2'
    version = '2.5.3'
    bridgeProtocol = 'wafc-bridge/2'
    sha256 = 'sha256:' + $adapterHash.ToLowerInvariant()
}
$adapterJson = ($adapterManifest | ConvertTo-Json -Depth 4) -replace "`r`n", "`n"
[System.IO.File]::WriteAllText(
    (Join-Path $adapterOutput 'adapter-manifest.json'),
    $adapterJson + "`n",
    $utf8
)

$allowed = @(
    'adapter\adapter-manifest.json',
    'adapter\collector.iife.js',
    'manifest.json',
    'popup.html',
    'popup.js',
    'service-worker.js',
    'styles.css'
)
$outputPrefix = $outputRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$actual = @(Get-ChildItem -LiteralPath $outputRoot -File -Recurse | ForEach-Object {
    if (-not $_.FullName.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Extension output escaped its fixed root.'
    }
    $_.FullName.Substring($outputPrefix.Length)
} | Sort-Object)
if ([string]::Join("`n", $actual) -cne [string]::Join("`n", ($allowed | Sort-Object))) {
    throw 'Extension output contains a stale or unexpected file.'
}

Write-Host 'WAFC extension built.'
Write-Host "  Output:  $outputRoot"
Write-Host "  Adapter: sha256:$($adapterHash.ToLowerInvariant())"
