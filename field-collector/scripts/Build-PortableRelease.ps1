[CmdletBinding()]
param(
    [switch] $PlanOnly,
    [switch] $AllowDirty,
    [long] $SourceDateEpoch = 315532800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$MaxArchiveBytes = 50L * 1024L * 1024L

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)] $Item)

    return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-NoReparseComponents {
    param([Parameter(Mandatory = $true)][string] $Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Path has no filesystem root: $fullPath"
    }
    $current = $pathRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ($current.EndsWith(":")) {
        $current += [System.IO.Path]::DirectorySeparatorChar
    }
    $relative = $fullPath.Substring($pathRoot.Length)
    foreach ($component in $relative.Split(
        @([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
        $current = Join-Path $current $component
        if (-not (Test-Path -LiteralPath $current)) {
            break
        }
        $item = Get-Item -LiteralPath $current -Force
        if (Test-ReparsePoint -Item $item) {
            throw "Reparse points/junctions are forbidden in release paths: $current"
        }
    }
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string] $Root)

    Assert-NoReparseComponents -Path $Root
    $directories = New-Object 'System.Collections.Generic.Queue[string]'
    $directories.Enqueue([System.IO.Path]::GetFullPath($Root))
    while ($directories.Count -gt 0) {
        $directory = $directories.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (Test-ReparsePoint -Item $item) {
                throw "Reparse points/junctions are forbidden in release trees: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $directories.Enqueue($item.FullName)
            }
        }
    }
}

function Assert-FileExists {
    param([Parameter(Mandatory = $true)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file does not exist: $Path"
    }
    Assert-NoReparseComponents -Path $Path
}

function Assert-DirectoryExists {
    param([Parameter(Mandatory = $true)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Required directory does not exist: $Path"
    }
    Assert-NoReparseComponents -Path $Path
}

function Resolve-Dumpbin {
    $command = Get-Command dumpbin.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        Assert-FileExists -Path $command.Source
        return $command.Source
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
        throw "Visual Studio discovery failed: ProgramFiles(x86) is unavailable."
    }
    $vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
    Assert-FileExists -Path $vswhere
    $installations = @(
        @(
            & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($LASTEXITCODE -ne 0 -or $installations.Count -ne 1) {
        throw "Visual Studio discovery did not return exactly one current C++ installation."
    }

    $toolsetRoot = Join-Path $installations[0].Trim() "VC\Tools\MSVC"
    Assert-DirectoryExists -Path $toolsetRoot
    $toolsets = @(
        Get-ChildItem -LiteralPath $toolsetRoot -Directory |
            Sort-Object { [version] $_.Name } -Descending
    )
    foreach ($toolset in $toolsets) {
        $candidate = Join-Path $toolset.FullName "bin\Hostx64\x64\dumpbin.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Assert-FileExists -Path $candidate
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    throw "Visual Studio C++ tools are installed, but x64 dumpbin.exe was not found."
}

function Assert-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar

    if (-not $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the release output root: $fullPath"
    }
}

function Assert-ExactChildPath {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Root
    )

    Assert-PathUnderRoot -Path $Path -Root $Root
    $parent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path))
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (-not [string]::Equals($parent, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release deletion/move target must be an exact child of the output root: $Path"
    }
}

function Remove-SafeReleaseTree {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Root
    )

    Assert-ExactChildPath -Path $Path -Root $Root
    Assert-NoReparseComponents -Path $Root
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Release tree deletion target exists but is not a directory: $Path"
    }
    Assert-NoReparseTree -Root $Path
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Remove-SafeReleaseFile {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Root
    )

    Assert-ExactChildPath -Path $Path -Root $Root
    Assert-NoReparseComponents -Path $Root
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Release file deletion target exists but is not a regular file: $Path"
    }
    Assert-NoReparseComponents -Path $Path
    Remove-Item -LiteralPath $Path -Force
}

function Invoke-CargoMetadata {
    param(
        [Parameter(Mandatory = $true)][string] $ManifestPath,
        [Parameter(Mandatory = $true)][string] $PackageName
    )

    $metadataText = & cargo metadata `
        --manifest-path $ManifestPath `
        --format-version 1 `
        --no-deps `
        --locked
    if ($LASTEXITCODE -ne 0) {
        throw "cargo metadata failed for $ManifestPath"
    }

    $metadata = ($metadataText | Out-String) | ConvertFrom-Json
    $package = $metadata.packages | Where-Object { $_.name -eq $PackageName } | Select-Object -First 1
    if ($null -eq $package) {
        throw "Package '$PackageName' was not found in $ManifestPath"
    }
    return $package
}

function Invoke-ReleaseBuild {
    param([Parameter(Mandatory = $true)][string] $WorkspacePath)

    Write-Host "Building locked release workspace: $WorkspacePath"
    Push-Location -LiteralPath $WorkspacePath
    try {
        & cargo build --release --locked
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build --release --locked failed in $WorkspacePath"
        }
    }
    finally {
        Pop-Location
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Text
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Copy-NormalizedTextFile {
    param(
        [Parameter(Mandatory = $true)][string] $Source,
        [Parameter(Mandatory = $true)][string] $Destination
    )

    Assert-FileExists -Path $Source
    $text = [System.IO.File]::ReadAllText($Source)
    $normalized = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    Write-Utf8NoBom -Path $Destination -Text $normalized
}

function Copy-ValidatedExtensionPayload {
    param(
        [Parameter(Mandatory = $true)][string] $CollectorRoot,
        [Parameter(Mandatory = $true)][string] $DestinationRoot
    )

    $sourceRoot = Join-Path $CollectorRoot "extension\src"
    $builtRoot = Join-Path $CollectorRoot "extension\dist"
    $adapterDevelopment = Join-Path $CollectorRoot "injector\src\collector.ts"
    $adapterBuilt = Join-Path $CollectorRoot "injector\dist\collector.iife.js"
    Assert-DirectoryExists -Path $sourceRoot
    Assert-DirectoryExists -Path $builtRoot
    Assert-NoReparseTree -Root $sourceRoot
    Assert-NoReparseTree -Root $builtRoot
    Assert-FileExists -Path $adapterDevelopment
    Assert-FileExists -Path $adapterBuilt

    [string[]] $expected = @(
        "adapter/adapter-manifest.json",
        "adapter/collector.iife.js",
        "manifest.json",
        "popup.html",
        "popup.js",
        "service-worker.js",
        "styles.css"
    )
    [string[]] $actual = @(Get-SortedRelativeFiles -Root $builtRoot)
    if ([string]::Join("`n", $actual) -cne [string]::Join("`n", $expected)) {
        throw "Built extension contains a stale or unexpected file. Run Build-Extension.ps1."
    }
    foreach ($name in @("manifest.json", "popup.html", "popup.js", "service-worker.js", "styles.css")) {
        $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $name) -Algorithm SHA256).Hash
        $builtHash = (Get-FileHash -LiteralPath (Join-Path $builtRoot $name) -Algorithm SHA256).Hash
        if ($sourceHash -cne $builtHash) {
            throw "Built extension shell is stale: $name"
        }
    }
    $developmentHash = (Get-FileHash -LiteralPath $adapterDevelopment -Algorithm SHA256).Hash.ToLowerInvariant()
    $adapterHash = (Get-FileHash -LiteralPath $adapterBuilt -Algorithm SHA256).Hash.ToLowerInvariant()
    $packagedAdapterHash = (Get-FileHash -LiteralPath (Join-Path $builtRoot "adapter\collector.iife.js") -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($developmentHash -cne $adapterHash -or $adapterHash -cne $packagedAdapterHash) {
        throw "Adapter source, embedded artifact, and extension payload differ. Run Build-Extension.ps1."
    }
    $adapterManifest = Get-Content -LiteralPath (Join-Path $builtRoot "adapter\adapter-manifest.json") -Raw | ConvertFrom-Json
    [string[]] $manifestProperties = @($adapterManifest.PSObject.Properties.Name)
    [System.Array]::Sort($manifestProperties, [System.StringComparer]::Ordinal)
    [string[]] $expectedProperties = @("adapterId", "schemaVersion", "sha256", "version")
    if ([string]::Join("`n", $manifestProperties) -cne [string]::Join("`n", $expectedProperties) `
        -or [string] $adapterManifest.schemaVersion -cne "wafc-adapter-manifest/1" `
        -or [string] $adapterManifest.adapterId -cne "wa-private-collections-v1" `
        -or [string] $adapterManifest.version -cne "1.0.0" `
        -or [string] $adapterManifest.sha256 -cne "sha256:$adapterHash") {
        throw "Adapter manifest does not bind the exact release Adapter."
    }

    New-Item -ItemType Directory -Path $DestinationRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $DestinationRoot "adapter") | Out-Null
    foreach ($relativePath in $expected) {
        $nativeRelative = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        [System.IO.File]::Copy(
            (Join-Path $builtRoot $nativeRelative),
            (Join-Path $DestinationRoot $nativeRelative),
            $false
        )
    }
    Assert-NoReparseTree -Root $DestinationRoot
}

function Get-SortedRelativeFiles {
    param([Parameter(Mandatory = $true)][string] $Root)

    Assert-DirectoryExists -Path $Root
    Assert-NoReparseTree -Root $Root
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $prefixLength = $rootFull.Length + 1
    [string[]] $relativePaths = @(
        Get-ChildItem -LiteralPath $rootFull -File -Recurse | ForEach-Object {
            $_.FullName.Substring($prefixLength).Replace(
                [System.IO.Path]::DirectorySeparatorChar,
                [char] '/'
            )
        }
    )
    [System.Array]::Sort($relativePaths, [System.StringComparer]::Ordinal)
    return $relativePaths
}

function Assert-PortablePayload {
    param([Parameter(Mandatory = $true)][string] $PackageRoot)

    [string[]] $expected = @(
        "LICENSE",
        "README.md",
        "SBOM.cdx.json",
        "SOURCE.md",
        "SOURCE_PROVENANCE.json",
        "THIRD_PARTY_LICENSES.txt",
        "THIRD_PARTY_NOTICES.md",
        "extension/adapter/adapter-manifest.json",
        "extension/adapter/collector.iife.js",
        "extension/manifest.json",
        "extension/popup.html",
        "extension/popup.js",
        "extension/service-worker.js",
        "extension/styles.css",
        "field-collector.exe",
        "release-manifest.json",
        "waeb-verify.exe"
    )
    [System.Array]::Sort($expected, [System.StringComparer]::Ordinal)

    [string[]] $actual = @(Get-SortedRelativeFiles -Root $PackageRoot)
    if ($actual.Count -ne $expected.Count) {
        throw "Portable payload contains an unexpected number of files. Expected $($expected.Count), got $($actual.Count)."
    }

    for ($index = 0; $index -lt $expected.Count; $index += 1) {
        if (-not [string]::Equals($expected[$index], $actual[$index], [System.StringComparison]::Ordinal)) {
            throw "Portable payload allowlist mismatch. Expected '$($expected[$index])', got '$($actual[$index])'."
        }
    }

    $forbiddenPattern = '(?i)(^|/)(target|node_modules|__pycache__)(/|$)|\.(pdb|ilk|exp|lib|dll|key|pem|p12|pfx|pk8|py|pyc|node)$'
    foreach ($relativePath in $actual) {
        if ($relativePath -match $forbiddenPattern) {
            throw "Forbidden release payload path: $relativePath"
        }
    }

    [string[]] $directories = @(
        Get-ChildItem -LiteralPath $PackageRoot -Directory -Force -Recurse |
            ForEach-Object {
                $_.FullName.Substring([System.IO.Path]::GetFullPath($PackageRoot).Length + 1).Replace(
                    [System.IO.Path]::DirectorySeparatorChar,
                    [char] '/'
                )
            }
    )
    [System.Array]::Sort($directories, [System.StringComparer]::Ordinal)
    [string[]] $expectedDirectories = @("extension", "extension/adapter")
    if ([string]::Join("`n", $directories) -cne [string]::Join("`n", $expectedDirectories)) {
        throw "Portable payload directory allowlist mismatch."
    }
}

function Assert-WindowsExecutable {
    param([Parameter(Mandatory = $true)][string] $Path)

    Assert-FileExists -Path $Path
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $first = $stream.ReadByte()
        $second = $stream.ReadByte()
        if ($first -ne 0x4D -or $second -ne 0x5A) {
            throw "Expected a Windows PE executable (MZ header): $Path"
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Assert-StaticWindowsCrt {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $DumpbinPath
    )

    Assert-WindowsExecutable -Path $Path
    $dumpbinLines = @(& $DumpbinPath /nologo /dependents $Path 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin /dependents failed for $Path"
    }
    $text = $dumpbinLines -join "`n"
    [string[]] $imports = @(
        [regex]::Matches($text, '(?im)^\s*([A-Za-z0-9_.-]+\.dll)\s*$') |
            ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() } |
            Sort-Object -Unique
    )
    if ($imports.Count -eq 0) {
        throw "Could not parse any PE imports from dumpbin output for $Path"
    }
    $forbiddenCrt = '(?i)^(vcruntime[0-9_]*|msvcp[0-9_]*|msvcr[0-9_]*|ucrtbase|api-ms-win-crt-[a-z0-9-]+)\.dll$'
    $dynamicCrt = @($imports | Where-Object { $_ -match $forbiddenCrt })
    if ($dynamicCrt.Count -ne 0) {
        throw "Portable executable dynamically imports the MSVC/UCRT runtime: $Path -> $($dynamicCrt -join ', ')"
    }
    return $imports
}

function Assert-ArchiveBelowLimit {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][long] $ExclusiveLimitBytes
    )

    Assert-FileExists -Path $Path
    $length = [long] (Get-Item -LiteralPath $Path).Length
    if ($length -ge $ExclusiveLimitBytes) {
        throw "Portable ZIP must be smaller than $ExclusiveLimitBytes bytes; got $length bytes: $Path"
    }
    return $length
}

function Get-SourceIdentity {
    param(
        [Parameter(Mandatory = $true)][string] $RepositoryRoot,
        [Parameter(Mandatory = $true)][string] $RepositoryUrl
    )

    if ($RepositoryUrl -notmatch '^https://[^\s]+$') {
        throw "Cargo package repository must be an HTTPS URL: $RepositoryUrl"
    }
    $commitLines = @(& git -C $RepositoryRoot rev-parse --verify HEAD)
    if ($LASTEXITCODE -ne 0) {
        throw "git rev-parse HEAD failed for $RepositoryRoot"
    }
    $commit = ($commitLines | Select-Object -First 1).Trim().ToLowerInvariant()
    if ($commit -notmatch '^[0-9a-f]{40,64}$') {
        throw "Git returned an invalid source commit: $commit"
    }
    $statusLines = @(& git -C $RepositoryRoot status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed for $RepositoryRoot"
    }
    $dirty = $statusLines.Count -ne 0
    [string[]] $tags = @(& git -C $RepositoryRoot tag --points-at $commit)
    if ($LASTEXITCODE -ne 0) {
        throw "git tag --points-at failed for $RepositoryRoot"
    }
    if ($tags.Count -gt 32) {
        throw "HEAD has more than 32 tags; refusing to embed an unbounded tag list"
    }
    $seenTags = @{}
    foreach ($tag in $tags) {
        if ($tag.Length -lt 1 -or $tag.Length -gt 128 `
            -or $tag -notmatch '^[0-9A-Za-z][0-9A-Za-z._+/-]*$' `
            -or $tag.EndsWith('/') `
            -or $tag.Contains('//') `
            -or $tag.Contains('..')) {
            throw "HEAD has an unsafe release tag; allowed tags are 1-128 conservative ASCII ref characters"
        }
        if ($seenTags.ContainsKey($tag)) {
            throw "git returned a duplicate HEAD tag"
        }
        $seenTags[$tag] = $true
    }
    [System.Array]::Sort($tags, [System.StringComparer]::Ordinal)
    $cleanRepositoryUrl = $RepositoryUrl.TrimEnd('/')
    if ($cleanRepositoryUrl.EndsWith('.git', [System.StringComparison]::OrdinalIgnoreCase)) {
        $cleanRepositoryUrl = $cleanRepositoryUrl.Substring(0, $cleanRepositoryUrl.Length - 4)
    }
    $sourceArchiveUrl = if ($cleanRepositoryUrl -match '^https://github\.com/[^/]+/[^/]+$') {
        "$cleanRepositoryUrl/archive/$commit.tar.gz"
    }
    else {
        $null
    }
    return [ordered]@{
        repository = $RepositoryUrl
        commit = $commit
        dirty = $dirty
        tags = $tags
        sourceArchiveUrl = $sourceArchiveUrl
    }
}

function Assert-SourceIdentityUnchanged {
    param(
        [Parameter(Mandatory = $true)] $Expected,
        [Parameter(Mandatory = $true)] $Actual
    )

    foreach ($field in @('repository', 'commit', 'dirty')) {
        if (-not [string]::Equals(
            [string] $Expected[$field],
            [string] $Actual[$field],
            [System.StringComparison]::Ordinal
        )) {
            throw "Release source identity changed while the artifact was being built: $field"
        }
    }
    [string[]] $expectedTags = @($Expected.tags)
    [string[]] $actualTags = @($Actual.tags)
    if ($expectedTags.Count -ne $actualTags.Count) {
        throw "Release source tags changed while the artifact was being built"
    }
    for ($index = 0; $index -lt $expectedTags.Count; $index += 1) {
        if (-not [string]::Equals(
            $expectedTags[$index],
            $actualTags[$index],
            [System.StringComparison]::Ordinal
        )) {
            throw "Release source tags changed while the artifact was being built"
        }
    }
}

function Get-SourceTreeInventory {
    param([Parameter(Mandatory = $true)][string] $RepositoryRoot)

    $pathLines = @(& git -C $RepositoryRoot ls-files `
        --cached `
        --others `
        --exclude-standard `
        -- `
        LICENSE `
        field-collector `
        tools/verify-cli `
        spec/wa-evidence-bag/v1/README.md `
        spec/wa-evidence-bag/v1/schemas)
    if ($LASTEXITCODE -ne 0) {
        throw "git ls-files failed while constructing source provenance"
    }
    [string[]] $relativePaths = @(
        foreach ($pathLine in $pathLines) {
            $relative = ([string] $pathLine).Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($relative)) {
                continue
            }
            if ($relative -ne 'LICENSE' `
                -and -not $relative.StartsWith('field-collector/', [System.StringComparison]::Ordinal) `
                -and -not $relative.StartsWith('tools/verify-cli/', [System.StringComparison]::Ordinal) `
                -and $relative -ne 'spec/wa-evidence-bag/v1/README.md' `
                -and -not $relative.StartsWith('spec/wa-evidence-bag/v1/schemas/', [System.StringComparison]::Ordinal)) {
                throw "git returned an out-of-scope source provenance path: $relative"
            }
            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $relative))
            Assert-PathUnderRoot -Path $fullPath -Root $RepositoryRoot
            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                # A tracked deletion is represented by dirty=true and absence
                # from the actual source tree inventory.
                continue
            }
            Assert-NoReparseComponents -Path $fullPath
            $relative
        }
    )
    [System.Array]::Sort($relativePaths, [System.StringComparer]::Ordinal)
    if ($relativePaths.Count -eq 0) {
        throw "Source provenance scope unexpectedly contains no files"
    }
    $files = @(
        foreach ($relativePath in $relativePaths) {
            $fullPath = Join-Path $RepositoryRoot $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $item = Get-Item -LiteralPath $fullPath -Force
            [ordered]@{
                path = $relativePath
                bytes = [long] $item.Length
                sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    )
    $rootMaterial = "WAFC-SOURCE-TREE-v1`n" + (($files | ForEach-Object {
        "$($_.sha256)  $($_.path)`n"
    }) -join '')
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $rootBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($rootMaterial)
        $rootHash = [System.BitConverter]::ToString($hasher.ComputeHash($rootBytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
    return [ordered]@{
        algorithm = "SHA-256"
        domain = "WAFC-SOURCE-TREE-v1"
        sourceTreeSha256 = $rootHash
        files = $files
    }
}

function New-SourceProvenance {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $Source,
        [Parameter(Mandatory = $true)] $Inventory
    )

    $document = [ordered]@{
        schemaVersion = "1.0.0"
        repository = [string] $Source.repository
        commit = [string] $Source.commit
        dirty = [bool] $Source.dirty
        tags = @($Source.tags)
        publishable = [bool] $Source.publishable
        sourceArchiveUrl = $Source.sourceArchiveUrl
        exactCommitArchive = -not [bool] $Source.dirty
        sourceTree = $Inventory
        scope = @(
            "LICENSE",
            "field-collector/ (excluding ignored build/output paths)",
            "tools/verify-cli/ (excluding ignored build/output paths)",
            "spec/wa-evidence-bag/v1/README.md",
            "spec/wa-evidence-bag/v1/schemas/ (trusted schemas embedded in both release binaries)"
        )
        exclusions = @(
            "tmp/ and all evidence/sample/user data",
            "spec/wa-evidence-bag/v1/examples/, test-vectors/, tools/, and development-only inputs",
            "unrelated legacy applications and user-deleted paths",
            "Cargo target/, field-collector/out/, .cargo-vendor/, and other git-ignored outputs"
        )
    }
    $json = ($document | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n"
    Write-Utf8NoBom -Path $Path -Text $json
}

function New-SourceNotice {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $Source,
        [Parameter(Mandatory = $true)] $Inventory
    )

    $archive = if ($null -eq $Source.sourceArchiveUrl) {
        "Obtain the repository above and check out the exact commit."
    }
    else {
        "Source archive: $($Source.sourceArchiveUrl)"
    }
    $releaseStatus = if ($Source.publishable) {
        "Release status: publishable; the working tree was clean and HEAD had an exact tag at build time."
    }
    elseif ($Source.dirty) {
        "WARNING: This development build was produced from a dirty working tree. The commit alone is not exact corresponding source; do not publish this artifact. Preserve and distribute the complete build working tree."
    }
    elseif (@($Source.tags).Count -eq 0) {
        "WARNING: This development build was produced from an untagged commit; do not publish this artifact."
    }
    else {
        "WARNING: This build used the development override and is marked non-publishable."
    }
    $tagText = if (@($Source.tags).Count -eq 0) { "(none)" } else { @($Source.tags) -join ', ' }
    $text = @"
# Corresponding Source

Repository: $($Source.repository)
Commit: $($Source.commit)
Exact HEAD tags: $tagText
Publishable: $($Source.publishable.ToString().ToLowerInvariant())
Source tree SHA-256: $($Inventory.sourceTreeSha256)
Machine-readable inventory: SOURCE_PROVENANCE.json
$archive
$releaseStatus

This binary distribution is licensed under AGPL-3.0-only. Recipients must be given access to the complete corresponding source, including both Cargo.lock files and build scripts, through the same distribution channel or another method permitted by the license.
"@
    $normalized = $text.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd() + "`n"
    Write-Utf8NoBom -Path $Path -Text $normalized
}

function New-ReleaseManifest {
    param(
        [Parameter(Mandatory = $true)][string] $PackageRoot,
        [Parameter(Mandatory = $true)][string] $CollectorVersion,
        [Parameter(Mandatory = $true)][string] $VerifierVersion,
        [Parameter(Mandatory = $true)][long] $Epoch,
        [Parameter(Mandatory = $true)][string] $RustcVersion,
        [Parameter(Mandatory = $true)][string] $CollectorLockPath,
        [Parameter(Mandatory = $true)][string] $VerifierLockPath,
        [Parameter(Mandatory = $true)] $Source,
        [Parameter(Mandatory = $true)] $SourceInventory,
        [Parameter(Mandatory = $true)][string[]] $CollectorImports,
        [Parameter(Mandatory = $true)][string[]] $VerifierImports,
        [Parameter(Mandatory = $true)][long] $ArchiveExclusiveLimitBytes
    )

    [string[]] $payloadPaths = @(
        "LICENSE",
        "README.md",
        "SBOM.cdx.json",
        "SOURCE.md",
        "SOURCE_PROVENANCE.json",
        "THIRD_PARTY_LICENSES.txt",
        "THIRD_PARTY_NOTICES.md",
        "extension/adapter/adapter-manifest.json",
        "extension/adapter/collector.iife.js",
        "extension/manifest.json",
        "extension/popup.html",
        "extension/popup.js",
        "extension/service-worker.js",
        "extension/styles.css",
        "field-collector.exe",
        "waeb-verify.exe"
    )
    [System.Array]::Sort($payloadPaths, [System.StringComparer]::Ordinal)

    $files = @(
        foreach ($relativePath in $payloadPaths) {
            $nativeRelativePath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $fullPath = Join-Path $PackageRoot $nativeRelativePath
            Assert-FileExists -Path $fullPath
            $item = Get-Item -LiteralPath $fullPath
            $digest = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
            [ordered]@{
                path = $relativePath
                bytes = [long] $item.Length
                sha256 = $digest
            }
        }
    )

    $manifest = [ordered]@{
        schemaVersion = "1.0.0"
        product = "WhatsApp Field Collector portable release"
        releaseVersion = $CollectorVersion
        target = "x86_64-pc-windows-msvc"
        sourceDateEpoch = $Epoch
        archiveExclusiveLimitBytes = $ArchiveExclusiveLimitBytes
        hashAlgorithm = "SHA-256"
        manifestScope = "payload files; release-manifest.json intentionally excludes itself"
        toolchain = [ordered]@{
            rustc = $RustcVersion
            linkerReproducibilityFlag = "/Brepro"
            staticMsvcCrt = $true
        }
        source = [ordered]@{
            repository = [string] $Source.repository
            commit = [string] $Source.commit
            dirty = [bool] $Source.dirty
            tags = @($Source.tags)
            publishable = [bool] $Source.publishable
            sourceArchiveUrl = $Source.sourceArchiveUrl
            sourceTreeSha256 = [string] $SourceInventory.sourceTreeSha256
            sourceProvenance = "SOURCE_PROVENANCE.json"
            correspondingSourceNotice = "SOURCE.md"
        }
        components = @(
            [ordered]@{
                name = "field-collector"
                version = $CollectorVersion
                peImports = @($CollectorImports)
            },
            [ordered]@{
                name = "waeb-verify"
                version = $VerifierVersion
                peImports = @($VerifierImports)
            },
            [ordered]@{
                name = "wafc-read-only-extension"
                version = $CollectorVersion
                manifest = "extension/manifest.json"
                adapterManifest = "extension/adapter/adapter-manifest.json"
                adapterSha256 = (Get-FileHash -LiteralPath (Join-Path $PackageRoot "extension\adapter\collector.iife.js") -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        )
        lockedInputs = @(
            [ordered]@{
                path = "field-collector/Cargo.lock"
                sha256 = (Get-FileHash -LiteralPath $CollectorLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
            },
            [ordered]@{
                path = "tools/verify-cli/Cargo.lock"
                sha256 = (Get-FileHash -LiteralPath $VerifierLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        )
        files = $files
    }

    $json = ($manifest | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n"
    Write-Utf8NoBom -Path (Join-Path $PackageRoot "release-manifest.json") -Text $json
}

function New-DeterministicZip {
    param(
        [Parameter(Mandatory = $true)][string] $PackageRoot,
        [Parameter(Mandatory = $true)][string] $ArchivePath,
        [Parameter(Mandatory = $true)][string] $ArchiveRootName,
        [Parameter(Mandatory = $true)][System.DateTimeOffset] $EntryTimestamp
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    if (Test-Path -LiteralPath $ArchivePath) {
        throw "Archive path already exists: $ArchivePath"
    }

    [string[]] $relativePaths = @(Get-SortedRelativeFiles -Root $PackageRoot)
    $archiveStream = [System.IO.File]::Open(
        $ArchivePath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $archive = $null
    try {
        $archive = New-Object System.IO.Compression.ZipArchive(
            $archiveStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        foreach ($relativePath in $relativePaths) {
            $entryName = "$ArchiveRootName/$relativePath"
            $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $EntryTimestamp
            $entry.ExternalAttributes = 0

            $nativeRelativePath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $sourcePath = Join-Path $PackageRoot $nativeRelativePath
            $sourceStream = [System.IO.File]::Open(
                $sourcePath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::Read
            )
            $entryStream = $null
            try {
                $entryStream = $entry.Open()
                $sourceStream.CopyTo($entryStream)
            }
            finally {
                if ($null -ne $entryStream) {
                    $entryStream.Dispose()
                }
                $sourceStream.Dispose()
            }
        }
    }
    finally {
        if ($null -ne $archive) {
            $archive.Dispose()
        }
        $archiveStream.Dispose()
    }
}

function Save-EnvironmentValue {
    param([Parameter(Mandatory = $true)][string] $Name)

    $path = "Env:$Name"
    return [ordered]@{
        exists = Test-Path $path
        value = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    }
}

function Restore-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)] $Saved
    )

    if ($Saved.exists) {
        [System.Environment]::SetEnvironmentVariable($Name, [string] $Saved.value, "Process")
    }
    else {
        [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
    }
}

$fieldCollectorRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$repositoryRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $fieldCollectorRoot))
$verifierRoot = Join-Path $repositoryRoot "tools\verify-cli"
$collectorManifest = Join-Path $fieldCollectorRoot "Cargo.toml"
$collectorLock = Join-Path $fieldCollectorRoot "Cargo.lock"
$verifierManifest = Join-Path $verifierRoot "Cargo.toml"
$verifierLock = Join-Path $verifierRoot "Cargo.lock"
$projectLicense = Join-Path $repositoryRoot "LICENSE"
$collectorReadme = Join-Path $fieldCollectorRoot "README.md"
$thirdPartyNotices = Join-Path $fieldCollectorRoot "THIRD_PARTY_NOTICES.md"
$sbomScript = Join-Path $PSScriptRoot "New-CargoSbom.ps1"
$extensionDist = Join-Path $fieldCollectorRoot "extension\dist"
$outputRoot = Join-Path $fieldCollectorRoot "out"

if ($SourceDateEpoch -lt 315532800 -or $SourceDateEpoch -gt 4354819198) {
    throw "SourceDateEpoch must fit the ZIP timestamp range (1980-01-01 through 2107-12-31 UTC)."
}

Get-Command cargo -ErrorAction Stop | Out-Null
Get-Command rustc -ErrorAction Stop | Out-Null
Get-Command git -ErrorAction Stop | Out-Null
Assert-NoReparseComponents -Path $repositoryRoot
Assert-DirectoryExists -Path $verifierRoot
foreach ($requiredFile in @(
    $collectorManifest,
    $collectorLock,
    $verifierManifest,
    $verifierLock,
    $projectLicense,
    $collectorReadme,
    $thirdPartyNotices,
    $sbomScript,
    (Join-Path $extensionDist "manifest.json"),
    (Join-Path $extensionDist "popup.html"),
    (Join-Path $extensionDist "popup.js"),
    (Join-Path $extensionDist "service-worker.js"),
    (Join-Path $extensionDist "styles.css"),
    (Join-Path $extensionDist "adapter\adapter-manifest.json"),
    (Join-Path $extensionDist "adapter\collector.iife.js")
)) {
    Assert-FileExists -Path $requiredFile
}

$rustVersionLines = @(& rustc -vV)
if ($LASTEXITCODE -ne 0) {
    throw "rustc -vV failed"
}
$rustVersionText = $rustVersionLines -join "`n"
if ($rustVersionText -notmatch '(?m)^host: x86_64-pc-windows-msvc$') {
    throw "Portable release builds require the x86_64-pc-windows-msvc host toolchain."
}
$rustcVersion = ($rustVersionLines | Select-Object -First 1).Trim()

$collectorPackage = Invoke-CargoMetadata -ManifestPath $collectorManifest -PackageName "field-collector"
$verifierPackage = Invoke-CargoMetadata -ManifestPath $verifierManifest -PackageName "waeb-verify"
$collectorVersion = [string] $collectorPackage.version
$verifierVersion = [string] $verifierPackage.version
$sourceIdentity = Get-SourceIdentity `
    -RepositoryRoot $repositoryRoot `
    -RepositoryUrl ([string] $collectorPackage.repository)
$sourceInventory = Get-SourceTreeInventory -RepositoryRoot $repositoryRoot
$sourceIdentity['publishable'] = [bool] (
    -not $AllowDirty -and -not $sourceIdentity.dirty -and @($sourceIdentity.tags).Count -gt 0
)
if ($collectorVersion -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
    throw "Collector version cannot be used safely in a release filename: $collectorVersion"
}

$archiveRootName = "whatsapp-field-collector-v$collectorVersion-windows-x86_64"
$finalPackageRoot = Join-Path $outputRoot $archiveRootName
$finalArchive = Join-Path $outputRoot "$archiveRootName.zip"
Assert-ExactChildPath -Path $finalPackageRoot -Root $outputRoot
Assert-ExactChildPath -Path $finalArchive -Root $outputRoot

if ($PlanOnly) {
    Write-Host "Portable release plan validated; no release output was built or written."
    Write-Host "  Workspace 1: $fieldCollectorRoot"
    Write-Host "    cargo build --release --locked"
    Write-Host "  Workspace 2: $verifierRoot"
    Write-Host "    cargo build --release --locked"
    Write-Host "  Package:     $finalPackageRoot"
    Write-Host "  Archive:     $finalArchive"
    Write-Host "  ZIP epoch:   $SourceDateEpoch"
    Write-Host "  Source:      $($sourceIdentity.repository) @ $($sourceIdentity.commit)"
    Write-Host "  Dirty:       $($sourceIdentity.dirty) (actual release requires -AllowDirty when true)"
    $planTags = if (@($sourceIdentity.tags).Count -eq 0) { "(none)" } else { @($sourceIdentity.tags) -join ', ' }
    Write-Host "  HEAD tags:   $planTags"
    Write-Host "  Publishable: $($sourceIdentity.publishable)"
    Write-Host "  Source tree: $($sourceInventory.sourceTreeSha256) ($($sourceInventory.files.Count) files)"
    return
}

if ($sourceIdentity.dirty -and -not $AllowDirty) {
    throw "Refusing a formal portable release from a dirty working tree. Commit/stash changes or pass -AllowDirty for a non-publishable development artifact."
}
if (@($sourceIdentity.tags).Count -eq 0 -and -not $AllowDirty) {
    throw "Refusing a formal portable release from an untagged HEAD. Create an exact release tag or pass -AllowDirty for a non-publishable development artifact."
}

$dumpbinPath = Resolve-Dumpbin
if (Test-Path -LiteralPath $outputRoot) {
    Assert-DirectoryExists -Path $outputRoot
}
else {
    Assert-NoReparseComponents -Path $fieldCollectorRoot
    New-Item -ItemType Directory -Path $outputRoot | Out-Null
    Assert-DirectoryExists -Path $outputRoot
}

$environmentNames = @(
    "SOURCE_DATE_EPOCH",
    "CARGO_INCREMENTAL",
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET",
    "RUSTFLAGS",
    "CARGO_ENCODED_RUSTFLAGS"
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = Save-EnvironmentValue -Name $name
}

$stageRoot = Join-Path $outputRoot (".stage-{0}-{1}" -f $PID, [guid]::NewGuid().ToString("N"))
$stagePackageRoot = Join-Path $stageRoot $archiveRootName
$stageArchive = Join-Path $stageRoot "$archiveRootName.zip"
$verificationArchive = Join-Path $stageRoot "$archiveRootName.repro-check.zip"
Assert-ExactChildPath -Path $stageRoot -Root $outputRoot

try {
    [System.Environment]::SetEnvironmentVariable("SOURCE_DATE_EPOCH", [string] $SourceDateEpoch, "Process")
    [System.Environment]::SetEnvironmentVariable("CARGO_INCREMENTAL", "0", "Process")
    [System.Environment]::SetEnvironmentVariable("CARGO_TARGET_DIR", $null, "Process")
    [System.Environment]::SetEnvironmentVariable("CARGO_BUILD_TARGET", $null, "Process")
    [System.Environment]::SetEnvironmentVariable("CARGO_ENCODED_RUSTFLAGS", $null, "Process")
    [System.Environment]::SetEnvironmentVariable(
        "RUSTFLAGS",
        "-C target-feature=+crt-static -C link-arg=/Brepro",
        "Process"
    )

    Invoke-ReleaseBuild -WorkspacePath $fieldCollectorRoot
    Invoke-ReleaseBuild -WorkspacePath $verifierRoot
    $postBuildSourceIdentity = Get-SourceIdentity `
        -RepositoryRoot $repositoryRoot `
        -RepositoryUrl ([string] $collectorPackage.repository)
    Assert-SourceIdentityUnchanged -Expected $sourceIdentity -Actual $postBuildSourceIdentity
    $postBuildSourceInventory = Get-SourceTreeInventory -RepositoryRoot $repositoryRoot
    if (-not [string]::Equals(
        [string] $sourceInventory.sourceTreeSha256,
        [string] $postBuildSourceInventory.sourceTreeSha256,
        [System.StringComparison]::Ordinal
    )) {
        throw "Release source tree changed while binaries were being built"
    }

    $collectorExecutable = Join-Path $fieldCollectorRoot "target\release\field-collector.exe"
    $verifierExecutable = Join-Path $verifierRoot "target\release\waeb-verify.exe"
    Assert-WindowsExecutable -Path $collectorExecutable
    Assert-WindowsExecutable -Path $verifierExecutable
    [string[]] $collectorImports = @(
        Assert-StaticWindowsCrt -Path $collectorExecutable -DumpbinPath $dumpbinPath
    )
    [string[]] $verifierImports = @(
        Assert-StaticWindowsCrt -Path $verifierExecutable -DumpbinPath $dumpbinPath
    )

    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    Assert-DirectoryExists -Path $stageRoot
    New-Item -ItemType Directory -Path $stagePackageRoot | Out-Null
    Assert-DirectoryExists -Path $stagePackageRoot
    Copy-Item -LiteralPath $collectorExecutable -Destination (Join-Path $stagePackageRoot "field-collector.exe")
    Copy-Item -LiteralPath $verifierExecutable -Destination (Join-Path $stagePackageRoot "waeb-verify.exe")
    Copy-ValidatedExtensionPayload `
        -CollectorRoot $fieldCollectorRoot `
        -DestinationRoot (Join-Path $stagePackageRoot "extension")
    Copy-NormalizedTextFile -Source $projectLicense -Destination (Join-Path $stagePackageRoot "LICENSE")
    Copy-NormalizedTextFile -Source $collectorReadme -Destination (Join-Path $stagePackageRoot "README.md")
    Copy-NormalizedTextFile -Source $thirdPartyNotices -Destination (Join-Path $stagePackageRoot "THIRD_PARTY_NOTICES.md")
    New-SourceNotice `
        -Path (Join-Path $stagePackageRoot "SOURCE.md") `
        -Source $sourceIdentity `
        -Inventory $sourceInventory
    New-SourceProvenance `
        -Path (Join-Path $stagePackageRoot "SOURCE_PROVENANCE.json") `
        -Source $sourceIdentity `
        -Inventory $sourceInventory
    & $sbomScript `
        -CollectorManifest $collectorManifest `
        -VerifierManifest $verifierManifest `
        -OutputPath (Join-Path $stagePackageRoot "SBOM.cdx.json") `
        -ThirdPartyLicensesPath (Join-Path $stagePackageRoot "THIRD_PARTY_LICENSES.txt") `
        -SourceDateEpoch $SourceDateEpoch
    if ($LASTEXITCODE -ne 0) {
        throw "CycloneDX SBOM generation failed"
    }

    New-ReleaseManifest `
        -PackageRoot $stagePackageRoot `
        -CollectorVersion $collectorVersion `
        -VerifierVersion $verifierVersion `
        -Epoch $SourceDateEpoch `
        -RustcVersion $rustcVersion `
        -CollectorLockPath $collectorLock `
        -VerifierLockPath $verifierLock `
        -Source $sourceIdentity `
        -SourceInventory $sourceInventory `
        -CollectorImports $collectorImports `
        -VerifierImports $verifierImports `
        -ArchiveExclusiveLimitBytes $MaxArchiveBytes
    Assert-PortablePayload -PackageRoot $stagePackageRoot

    $zipTimestamp = [System.DateTimeOffset]::FromUnixTimeSeconds($SourceDateEpoch)
    New-DeterministicZip `
        -PackageRoot $stagePackageRoot `
        -ArchivePath $stageArchive `
        -ArchiveRootName $archiveRootName `
        -EntryTimestamp $zipTimestamp
    New-DeterministicZip `
        -PackageRoot $stagePackageRoot `
        -ArchivePath $verificationArchive `
        -ArchiveRootName $archiveRootName `
        -EntryTimestamp $zipTimestamp

    $archiveHash = (Get-FileHash -LiteralPath $stageArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    $verificationHash = (Get-FileHash -LiteralPath $verificationArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($archiveHash, $verificationHash, [System.StringComparison]::Ordinal)) {
        throw "Deterministic ZIP self-check failed: repeated archives have different SHA-256 values."
    }
    $archiveBytes = Assert-ArchiveBelowLimit `
        -Path $stageArchive `
        -ExclusiveLimitBytes $MaxArchiveBytes
    $verificationArchiveBytes = Assert-ArchiveBelowLimit `
        -Path $verificationArchive `
        -ExclusiveLimitBytes $MaxArchiveBytes
    if ($archiveBytes -ne $verificationArchiveBytes) {
        throw "Deterministic ZIP self-check produced different archive lengths."
    }
    $prePromotionSourceInventory = Get-SourceTreeInventory -RepositoryRoot $repositoryRoot
    if (-not [string]::Equals(
        [string] $sourceInventory.sourceTreeSha256,
        [string] $prePromotionSourceInventory.sourceTreeSha256,
        [System.StringComparison]::Ordinal
    )) {
        throw "Release source tree changed while the package was being assembled"
    }
    $prePromotionSourceIdentity = Get-SourceIdentity `
        -RepositoryRoot $repositoryRoot `
        -RepositoryUrl ([string] $collectorPackage.repository)
    Assert-SourceIdentityUnchanged -Expected $sourceIdentity -Actual $prePromotionSourceIdentity

    Remove-SafeReleaseTree -Path $finalPackageRoot -Root $outputRoot
    Remove-SafeReleaseFile -Path $finalArchive -Root $outputRoot
    Assert-NoReparseTree -Root $stagePackageRoot
    Assert-NoReparseComponents -Path $stageArchive
    Assert-NoReparseComponents -Path $outputRoot
    Move-Item -LiteralPath $stagePackageRoot -Destination $finalPackageRoot
    Move-Item -LiteralPath $stageArchive -Destination $finalArchive

    $manifestHash = (Get-FileHash -LiteralPath (Join-Path $finalPackageRoot "release-manifest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Portable release created."
    Write-Host "  Package:         $finalPackageRoot"
    Write-Host "  Archive:         $finalArchive"
    Write-Host "  Archive SHA-256: $archiveHash"
    Write-Host "  Archive bytes:  $archiveBytes (< $MaxArchiveBytes)"
    Write-Host "  Manifest SHA-256: $manifestHash"
    Write-Host "  Source tree SHA-256: $($sourceInventory.sourceTreeSha256)"
    Write-Host "  Publishable:     $($sourceIdentity.publishable)"
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-SafeReleaseTree -Path $stageRoot -Root $outputRoot
    }
    foreach ($name in $environmentNames) {
        Restore-EnvironmentValue -Name $name -Saved $savedEnvironment[$name]
    }
}
