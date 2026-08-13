[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $CollectorManifest,
    [Parameter(Mandatory = $true)][string] $VerifierManifest,
    [Parameter(Mandatory = $true)][string] $OutputPath,
    [Parameter(Mandatory = $true)][string] $ThirdPartyLicensesPath,
    [long] $SourceDateEpoch = 315532800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$MaxLicenseFileBytes = 2L * 1024L * 1024L
$MaxLicenseBytesPerPackage = 8L * 1024L * 1024L
$MaxLicenseFilesPerPackage = 128
$MaxLicenseEntriesScannedPerPackage = 512

$AllowedThirdPartyLicenses = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)
foreach ($licenseId in @(
    "0BSD",
    "Apache-2.0",
    "BSD-1-Clause",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "Unicode-3.0",
    "Unlicense",
    "Zlib"
)) {
    [void] $AllowedThirdPartyLicenses.Add($licenseId)
}

$LicenseOverrideRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..\third_party\license-overrides")
)
$AuditedLicenseOverrides = [System.Collections.Generic.Dictionary[string, object]]::new(
    [System.StringComparer]::Ordinal
)
$AuditedLicenseOverrides.Add("clipboard-win@5.4.1", [pscustomobject]@{
    Spdx = "BSL-1.0"
    RelativePath = "clipboard-win-5.4.1\LICENSE"
    Sha256 = "c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566"
})
$apacheOverride = [pscustomobject]@{
    RelativePath = "standard\Apache-2.0.txt"
    Sha256 = "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a"
}
$accessKitOverrideFiles = @(
    [pscustomobject]@{
        RelativePath = $apacheOverride.RelativePath
        Sha256 = $apacheOverride.Sha256
        IsPrimary = $true
    },
    [pscustomobject]@{
        RelativePath = "accesskit\LICENSE.chromium"
        Sha256 = "f26a603276d24923a35db6ce4a7eb2ef89f61e050824c748d9b6adbd60acd8d4"
        IsPrimary = $false
    }
)
foreach ($packageLabel in @(
    "ecolor@0.33.3",
    "eframe@0.33.3",
    "egui@0.33.3",
    "egui_glow@0.33.3",
    "egui-winit@0.33.3",
    "emath@0.33.3",
    "epaint@0.33.3",
    "profiling@1.0.18"
)) {
    $AuditedLicenseOverrides.Add($packageLabel, [pscustomobject]@{
        Spdx = "MIT OR Apache-2.0"
        RelativePath = $apacheOverride.RelativePath
        Sha256 = $apacheOverride.Sha256
    })
}
foreach ($packageLabel in @("gl_generator@0.14.0", "khronos_api@3.1.0")) {
    $AuditedLicenseOverrides.Add($packageLabel, [pscustomobject]@{
        Spdx = "Apache-2.0"
        RelativePath = $apacheOverride.RelativePath
        Sha256 = $apacheOverride.Sha256
    })
}
foreach ($packageLabel in @(
    "accesskit@0.21.1",
    "accesskit_consumer@0.31.0",
    "accesskit_windows@0.29.2"
)) {
    $AuditedLicenseOverrides.Add($packageLabel, [pscustomobject]@{
        Spdx = "MIT OR Apache-2.0"
        Files = $accessKitOverrideFiles
    })
}
$AuditedLicenseOverrides.Add("accesskit_winit@0.29.2", [pscustomobject]@{
    Spdx = "Apache-2.0"
    Files = $accessKitOverrideFiles
})

function New-OrdinalMap {
    return [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::Ordinal
    )
}

function Assert-NoReparseComponents {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [switch] $RequireExisting
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Path has no filesystem root: $fullPath"
    }
    $current = $pathRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ($current.EndsWith(":", [System.StringComparison]::Ordinal)) {
        $current += [System.IO.Path]::DirectorySeparatorChar
    }
    $relative = $fullPath.Substring($pathRoot.Length)
    foreach ($component in $relative.Split(
        @([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
        $current = Join-Path $current $component
        if (-not (Test-Path -LiteralPath $current)) {
            if ($RequireExisting) {
                throw "Required path component does not exist: $current"
            }
            return
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points/junctions are forbidden: $current"
        }
    }
}

function Assert-SafeBundleField {
    param(
        [Parameter(Mandatory = $true)][string] $Value,
        [Parameter(Mandatory = $true)][string] $Field,
        [int] $MaxLength = 2048
    )

    if ($Value.Length -gt $MaxLength) {
        throw "Bundle field '$Field' exceeds $MaxLength characters"
    }
    if ($Value -match '[\x00-\x1F\x7F]') {
        throw "Bundle field '$Field' contains a forbidden control character"
    }
}

function ConvertTo-NormalizedSpdxExpression {
    param(
        [Parameter(Mandatory = $true)][string] $Expression,
        [Parameter(Mandatory = $true)][string] $PackageLabel,
        [switch] $FirstParty
    )

    $normalized = $Expression.Trim()
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        throw "Package '$PackageLabel' has a missing license expression"
    }

    # Cargo historically accepted slash-separated alternatives. A bare slash is
    # not valid SPDX syntax, so normalize only the unambiguous ID/ID form.
    if ($normalized -match '^[A-Za-z0-9.-]+(?:/[A-Za-z0-9.-]+)+$') {
        $normalized = (($normalized -split '/') -join ' OR ')
    }
    elseif ($normalized.Contains('/')) {
        throw "Package '$PackageLabel' has an unsupported non-SPDX license expression: $Expression"
    }
    if ($FirstParty -and $normalized -cne 'AGPL-3.0-only') {
        throw "First-party package '$PackageLabel' must declare exactly AGPL-3.0-only, not '$Expression'"
    }

    $matches = [regex]::Matches($normalized, '\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.-]*')
    if ($matches.Count -eq 0) {
        throw "Package '$PackageLabel' has an invalid SPDX license expression: $Expression"
    }
    $unmatched = [regex]::Replace($normalized, '\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.-]*', '')
    if (-not [string]::IsNullOrWhiteSpace($unmatched)) {
        throw "Package '$PackageLabel' has an invalid SPDX license expression: $Expression"
    }

    $expectOperand = $true
    $parentheses = 0
    $canonicalTokens = New-Object 'System.Collections.Generic.List[string]'
    foreach ($match in $matches) {
        $token = [string] $match.Value
        switch -CaseSensitive ($token) {
            '(' {
                if (-not $expectOperand) {
                    throw "Package '$PackageLabel' has an invalid SPDX expression near '(': $Expression"
                }
                $parentheses++
                $canonicalTokens.Add($token)
            }
            ')' {
                if ($expectOperand -or $parentheses -le 0) {
                    throw "Package '$PackageLabel' has an invalid SPDX expression near ')': $Expression"
                }
                $parentheses--
                $canonicalTokens.Add($token)
            }
            { $_ -ceq 'AND' -or $_ -ceq 'OR' } {
                if ($expectOperand) {
                    throw "Package '$PackageLabel' has an invalid SPDX operator sequence: $Expression"
                }
                $expectOperand = $true
                $canonicalTokens.Add($token)
            }
            'WITH' {
                throw "Package '$PackageLabel' uses an unreviewed SPDX exception: $Expression"
            }
            default {
                if (-not $expectOperand) {
                    throw "Package '$PackageLabel' has adjacent SPDX identifiers: $Expression"
                }
                if ($FirstParty) {
                    if ($token -cne 'AGPL-3.0-only') {
                        throw "First-party package '$PackageLabel' must be AGPL-3.0-only, not '$token'"
                    }
                }
                elseif (-not $AllowedThirdPartyLicenses.Contains($token)) {
                    throw "Third-party package '$PackageLabel' uses missing, unknown, copyleft, source-available, or otherwise unapproved license '$token'"
                }
                $expectOperand = $false
                $canonicalTokens.Add($token)
            }
        }
    }
    if ($expectOperand -or $parentheses -ne 0) {
        throw "Package '$PackageLabel' has an incomplete SPDX license expression: $Expression"
    }

    $result = (($canonicalTokens -join ' ') -replace '\( ', '(' -replace ' \)', ')')
    return $result
}

function Get-PackageLicenseFiles {
    param(
        [Parameter(Mandatory = $true)] $Package,
        [Parameter(Mandatory = $true)][string] $PackageLabel
    )

    $manifestPath = [System.IO.Path]::GetFullPath([string] $Package.manifest_path)
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Third-party package '$PackageLabel' has a missing Cargo manifest: $manifestPath"
    }
    Assert-NoReparseComponents -Path $manifestPath -RequireExisting
    $packageRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $manifestPath))
    Assert-NoReparseComponents -Path $packageRoot -RequireExisting
    $rootPrefix = $packageRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar

    $primaryPaths = New-Object 'System.Collections.Generic.List[string]'
    $supplementalPaths = New-Object 'System.Collections.Generic.List[string]'
    $licenseBearingNames = '^(LICENSE|LICENCE|COPYING|UNLICENSE)(\.|-|$)'
    $supplementalNames = '^(COPYRIGHT|NOTICE)(\.|-|$)'
    foreach ($rootFile in @(Get-ChildItem -LiteralPath $packageRoot -File -Force)) {
        if ($rootFile.Name -match $licenseBearingNames) {
            $primaryPaths.Add($rootFile.FullName)
        }
        elseif ($rootFile.Name -match $supplementalNames) {
            $supplementalPaths.Add($rootFile.FullName)
        }
    }

    if ($null -ne $Package.license_file -and -not [string]::IsNullOrWhiteSpace([string] $Package.license_file)) {
        $declaredPath = [string] $Package.license_file
        if (-not [System.IO.Path]::IsPathRooted($declaredPath)) {
            $declaredPath = Join-Path $packageRoot $declaredPath
        }
        $declaredPath = [System.IO.Path]::GetFullPath($declaredPath)
        if (-not $declaredPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Third-party package '$PackageLabel' declares a license file outside its source root: $declaredPath"
        }
        if (-not (Test-Path -LiteralPath $declaredPath -PathType Leaf)) {
            throw "Third-party package '$PackageLabel' declares a missing license file: $declaredPath"
        }
        Assert-NoReparseComponents -Path $declaredPath -RequireExisting
        $primaryPaths.Add($declaredPath)
    }

    $licensesDirectory = Join-Path $packageRoot "LICENSES"
    if (Test-Path -LiteralPath $licensesDirectory) {
        if (-not (Test-Path -LiteralPath $licensesDirectory -PathType Container)) {
            throw "Third-party package '$PackageLabel' has a non-directory LICENSES path: $licensesDirectory"
        }
        Assert-NoReparseComponents -Path $licensesDirectory -RequireExisting
        $licenseDirectoryFiles = New-Object 'System.Collections.Generic.List[string]'
        $directories = New-Object 'System.Collections.Generic.Queue[string]'
        $directories.Enqueue([System.IO.Path]::GetFullPath($licensesDirectory))
        $scannedEntries = 0
        while ($directories.Count -gt 0) {
            $directory = $directories.Dequeue()
            foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
                $scannedEntries++
                if ($scannedEntries -gt $MaxLicenseEntriesScannedPerPackage) {
                    throw "Third-party package '$PackageLabel' has too many entries beneath LICENSES/; limit is $MaxLicenseEntriesScannedPerPackage"
                }
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Third-party package '$PackageLabel' has a reparse point in LICENSES: $($item.FullName)"
                }
                $itemPath = [System.IO.Path]::GetFullPath($item.FullName)
                if (-not $itemPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Third-party package '$PackageLabel' has a LICENSES entry outside its source root: $itemPath"
                }
                Assert-NoReparseComponents -Path $itemPath -RequireExisting
                if ($item.PSIsContainer) {
                    $directories.Enqueue($itemPath)
                }
                elseif ($item -is [System.IO.FileInfo]) {
                    $licenseDirectoryFiles.Add($itemPath)
                    if ($licenseDirectoryFiles.Count -gt $MaxLicenseFilesPerPackage) {
                        throw "Third-party package '$PackageLabel' has too many files beneath LICENSES/; limit is $MaxLicenseFilesPerPackage"
                    }
                }
                else {
                    throw "Third-party package '$PackageLabel' has an unsupported LICENSES entry: $itemPath"
                }
            }
        }
        if ($licenseDirectoryFiles.Count -eq 0) {
            throw "Third-party package '$PackageLabel' has an empty LICENSES directory"
        }
        foreach ($licenseDirectoryFile in $licenseDirectoryFiles) {
            $primaryPaths.Add($licenseDirectoryFile)
        }
    }

    $pathKinds = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($supplementalPath in $supplementalPaths) {
        $pathKinds[[System.IO.Path]::GetFullPath($supplementalPath)] = "supplemental"
    }
    foreach ($primaryPath in $primaryPaths) {
        $pathKinds[[System.IO.Path]::GetFullPath($primaryPath)] = "primary"
    }
    $primaryCount = @($pathKinds.Values | Where-Object { $_ -ceq "primary" }).Count
    if ($primaryCount -eq 0) {
        $override = Get-AuditedLicenseOverride -Package $Package -PackageLabel $PackageLabel
        if ($null -eq $override) {
            throw "Third-party package '$PackageLabel' has no declared, root-level, LICENSES/, or audited exact-version license text"
        }
        return $override
    }

    [string[]] $candidatePaths = @($pathKinds.Keys)
    if ($candidatePaths.Count -gt $MaxLicenseFilesPerPackage) {
        throw "Third-party package '$PackageLabel' has too many license/notice files; limit is $MaxLicenseFilesPerPackage"
    }
    [System.Array]::Sort($candidatePaths, [System.StringComparer]::Ordinal)
    $files = New-Object 'System.Collections.Generic.List[object]'
    [long] $totalBytes = 0
    foreach ($candidatePath in $candidatePaths) {
        Assert-NoReparseComponents -Path $candidatePath -RequireExisting
        $file = Get-Item -LiteralPath $candidatePath -Force
        if (-not ($file -is [System.IO.FileInfo])) {
            throw "Third-party package '$PackageLabel' license entry is not a regular file: $candidatePath"
        }
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Third-party package '$PackageLabel' has a reparse-point license file: $($file.FullName)"
        }
        if ($file.Length -le 0) {
            throw "Third-party package '$PackageLabel' has an empty license or notice file: $($file.FullName)"
        }
        if ($file.Length -gt $MaxLicenseFileBytes) {
            throw "Third-party package '$PackageLabel' has an unexpectedly large license file: $($file.FullName)"
        }
        $totalBytes += [long] $file.Length
        if ($totalBytes -gt $MaxLicenseBytesPerPackage) {
            throw "Third-party package '$PackageLabel' license/notice files exceed the $MaxLicenseBytesPerPackage byte aggregate limit"
        }
        $text = Read-StrictUtf8Text -Path $file.FullName -PackageLabel $PackageLabel
        if ([string]::IsNullOrWhiteSpace($text)) {
            throw "Third-party package '$PackageLabel' has a blank license or notice file: $($file.FullName)"
        }
        $relativePath = $file.FullName.Substring($rootPrefix.Length).Replace(
            [System.IO.Path]::DirectorySeparatorChar,
            [char] '/'
        )
        Assert-SafeBundleField -Value $relativePath -Field "$PackageLabel license path" -MaxLength 1024
        $files.Add([pscustomobject]@{
            FullName = $file.FullName
            RelativePath = $relativePath
            Text = $text
            IsPrimary = $pathKinds[$candidatePath] -ceq "primary"
        })
    }
    return $files
}

function Get-AuditedLicenseOverride {
    param(
        [Parameter(Mandatory = $true)] $Package,
        [Parameter(Mandatory = $true)][string] $PackageLabel
    )

    if (-not $AuditedLicenseOverrides.ContainsKey($PackageLabel)) {
        return $null
    }
    $override = $AuditedLicenseOverrides[$PackageLabel]
    if ([string] $Package.license -cne [string] $override.Spdx) {
        throw "Audited license override for '$PackageLabel' does not match the package SPDX expression"
    }
    if (-not (Test-Path -LiteralPath $LicenseOverrideRoot -PathType Container)) {
        throw "Audited license override root does not exist: $LicenseOverrideRoot"
    }
    Assert-NoReparseComponents -Path $LicenseOverrideRoot -RequireExisting
    $rootPrefix = $LicenseOverrideRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    $fileSpecs = @()
    if ($null -ne $override.PSObject.Properties["Files"]) {
        $fileSpecs = @($override.Files)
    }
    else {
        $fileSpecs = @([pscustomobject]@{
            RelativePath = $override.RelativePath
            Sha256 = $override.Sha256
            IsPrimary = $true
        })
    }
    if ($fileSpecs.Count -eq 0 -or $fileSpecs.Count -gt $MaxLicenseFilesPerPackage) {
        throw "Audited license override for '$PackageLabel' has an invalid file count"
    }

    $seenPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $files = New-Object 'System.Collections.Generic.List[object]'
    [long] $totalBytes = 0
    [int] $primaryCount = 0
    foreach ($fileSpec in $fileSpecs) {
        $relativePath = [string] $fileSpec.RelativePath
        if ([string]::IsNullOrWhiteSpace($relativePath)) {
            throw "Audited license override for '$PackageLabel' has a blank path"
        }
        if (-not $seenPaths.Add($relativePath)) {
            throw "Audited license override for '$PackageLabel' repeats a path: $relativePath"
        }
        $isPrimary = [bool] $fileSpec.IsPrimary
        if ($isPrimary) {
            $primaryCount++
        }
        $path = [System.IO.Path]::GetFullPath((Join-Path $LicenseOverrideRoot $relativePath))
        if (-not $path.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Audited license override escapes its fixed root: $path"
        }
        Assert-NoReparseComponents -Path $path -RequireExisting
        $file = Get-Item -LiteralPath $path -Force
        if (-not ($file -is [System.IO.FileInfo]) -or
            (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
            $file.Length -le 0 -or
            $file.Length -gt $MaxLicenseFileBytes) {
            throw "Audited license override is not a safe bounded regular file: $path"
        }
        $totalBytes += [long] $file.Length
        if ($totalBytes -gt $MaxLicenseBytesPerPackage) {
            throw "Audited license override for '$PackageLabel' exceeds the aggregate byte limit"
        }
        $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -cne [string] $fileSpec.Sha256) {
            throw "Audited license override hash mismatch for '$PackageLabel': $relativePath"
        }
        $text = Read-StrictUtf8Text -Path $path -PackageLabel $PackageLabel
        if ([string]::IsNullOrWhiteSpace($text)) {
            throw "Audited license override is blank for '$PackageLabel': $relativePath"
        }
        $files.Add([pscustomobject]@{
            FullName = $path
            RelativePath = "AUDITED_OVERRIDE/$($relativePath.Replace([char] '\', [char] '/'))"
            Text = $text
            IsPrimary = $isPrimary
        })
    }
    if ($primaryCount -eq 0) {
        throw "Audited license override for '$PackageLabel' has no primary license text"
    }
    return $files
}

function Read-StrictUtf8Text {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $PackageLabel
    )

    try {
        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $text = [System.IO.File]::ReadAllText($Path, $strictUtf8)
    }
    catch {
        throw "Third-party package '$PackageLabel' has a license file that is not valid UTF-8: $Path"
    }
    return (($text -replace "`r`n", "`n") -replace "`r", "`n").TrimEnd("`n")
}

function Get-LockedMetadata {
    param([Parameter(Mandatory = $true)][string] $ManifestPath)

    $ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Cargo manifest does not exist: $ManifestPath"
    }
    Assert-NoReparseComponents -Path $ManifestPath -RequireExisting
    $text = & cargo metadata `
        --manifest-path $ManifestPath `
        --format-version 1 `
        --locked `
        --filter-platform x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) {
        throw "cargo metadata failed for $ManifestPath"
    }
    return (($text | Out-String) | ConvertFrom-Json)
}

function Test-IncludeCargoDependency {
    param([Parameter(Mandatory = $true)] $Dependency)

    if ($null -eq $Dependency.dep_kinds -or @($Dependency.dep_kinds).Count -eq 0) {
        throw "Cargo metadata dependency has no dep_kinds: $($Dependency.pkg)"
    }
    foreach ($kind in $Dependency.dep_kinds) {
        if ($null -eq $kind.kind -or [string] $kind.kind -cne "dev") {
            return $true
        }
    }
    return $false
}

function Get-ReachableGraph {
    param(
        [Parameter(Mandatory = $true)] $Metadata,
        [Parameter(Mandatory = $true)][string] $RootPackageName
    )

    $workspaceIds = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($workspaceId in $Metadata.workspace_members) {
        [void] $workspaceIds.Add([string] $workspaceId)
    }
    $rootCandidates = @(
        $Metadata.packages | Where-Object {
            [string] $_.name -ceq $RootPackageName -and $workspaceIds.Contains([string] $_.id)
        }
    )
    if ($rootCandidates.Count -ne 1) {
        throw "Expected exactly one workspace package named '$RootPackageName'; found $($rootCandidates.Count)"
    }
    $root = $rootCandidates[0]

    $nodes = New-OrdinalMap
    foreach ($node in $Metadata.resolve.nodes) {
        $nodes[[string] $node.id] = $node
    }

    $visited = New-OrdinalMap
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue([string] $root.id)
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($visited.ContainsKey($id)) {
            continue
        }
        $visited[$id] = $true
        if (-not $nodes.ContainsKey($id)) {
            throw "Reachable Cargo package is missing a resolve node: $id"
        }
        foreach ($dependency in $nodes[$id].deps) {
            if (Test-IncludeCargoDependency -Dependency $dependency) {
                $queue.Enqueue([string] $dependency.pkg)
            }
        }
    }

    return [ordered]@{
        metadata = $Metadata
        rootId = [string] $root.id
        ids = $visited
        nodes = $nodes
    }
}

function Get-Purl {
    param([Parameter(Mandatory = $true)] $Package)

    return "pkg:cargo/$($Package.name)@$($Package.version)"
}

function Get-NonDevDependencyIds {
    param([Parameter(Mandatory = $true)] $Node)

    $ids = @(
        foreach ($dependency in $Node.deps) {
            if (Test-IncludeCargoDependency -Dependency $dependency) {
                [string] $dependency.pkg
            }
        }
    )
    return $ids
}

function Add-Graph {
    param(
        [Parameter(Mandatory = $true)] $Graph,
        [Parameter(Mandatory = $true)] $PackageByPurl,
        [Parameter(Mandatory = $true)] $IdToPurl,
        [Parameter(Mandatory = $true)] $DependencySets
    )

    $packagesById = New-OrdinalMap
    foreach ($package in $Graph.metadata.packages) {
        $packagesById[[string] $package.id] = $package
    }
    foreach ($id in $Graph.ids.Keys) {
        if (-not $packagesById.ContainsKey($id)) {
            throw "Resolved Cargo package is missing from metadata: $id"
        }
        $package = $packagesById[$id]
        $purl = Get-Purl -Package $package
        $IdToPurl[$id] = $purl
        if (-not $PackageByPurl.ContainsKey($purl)) {
            $PackageByPurl[$purl] = $package
        }
        elseif ([string] $PackageByPurl[$purl].id -cne [string] $package.id) {
            throw "Cargo packages with different sources collide on PURL '$purl'; source-qualified PURL review is required"
        }
        if (-not $DependencySets.ContainsKey($purl)) {
            $DependencySets[$purl] = New-OrdinalMap
        }
    }
    foreach ($id in $Graph.ids.Keys) {
        if (-not $Graph.nodes.ContainsKey($id)) {
            throw "Reachable Cargo package is missing a resolve node while constructing dependencies: $id"
        }
        $fromPurl = $IdToPurl[$id]
        foreach ($dependencyId in (Get-NonDevDependencyIds -Node $Graph.nodes[$id])) {
            if ($Graph.ids.ContainsKey($dependencyId) -and $IdToPurl.ContainsKey($dependencyId)) {
                $DependencySets[$fromPurl][$IdToPurl[$dependencyId]] = $true
            }
        }
    }
}

$collectorMetadata = Get-LockedMetadata -ManifestPath $CollectorManifest
$verifierMetadata = Get-LockedMetadata -ManifestPath $VerifierManifest
$collectorGraph = Get-ReachableGraph -Metadata $collectorMetadata -RootPackageName "field-collector"
$verifierGraph = Get-ReachableGraph -Metadata $verifierMetadata -RootPackageName "waeb-verify"

$packageByPurl = New-OrdinalMap
$idToPurl = New-OrdinalMap
$dependencySets = New-OrdinalMap
Add-Graph -Graph $collectorGraph -PackageByPurl $packageByPurl -IdToPurl $idToPurl -DependencySets $dependencySets
Add-Graph -Graph $verifierGraph -PackageByPurl $packageByPurl -IdToPurl $idToPurl -DependencySets $dependencySets

$firstPartyPurls = New-OrdinalMap
foreach ($workspaceId in @($collectorMetadata.workspace_members) + @($verifierMetadata.workspace_members)) {
    $id = [string] $workspaceId
    if (-not $idToPurl.ContainsKey($id)) {
        throw "Workspace package is missing from the resolved release graph: $id"
    }
    $firstPartyPurls[$idToPurl[$id]] = $true
}

$collectorRootPurl = $idToPurl[$collectorGraph.rootId]
$verifierRootPurl = $idToPurl[$verifierGraph.rootId]
$productRef = "urn:wafc:portable-release:$($packageByPurl[$collectorRootPurl].version)"

[string[]] $purls = @($packageByPurl.Keys)
[System.Array]::Sort($purls, [System.StringComparer]::Ordinal)
$components = @(
    foreach ($purl in $purls) {
        $package = $packageByPurl[$purl]
        $packageLabel = "$($package.name)@$($package.version)"
        if ($null -eq $package.license -or [string]::IsNullOrWhiteSpace([string] $package.license)) {
            throw "Package '$packageLabel' has no Cargo license metadata"
        }
        $normalizedLicense = ConvertTo-NormalizedSpdxExpression `
            -Expression ([string] $package.license) `
            -PackageLabel $packageLabel `
            -FirstParty:$firstPartyPurls.ContainsKey($purl)
        $component = [ordered]@{
            type = if ($purl -eq $collectorRootPurl -or $purl -eq $verifierRootPurl) { "application" } else { "library" }
            'bom-ref' = $purl
            name = [string] $package.name
            version = [string] $package.version
            purl = $purl
            licenses = @([ordered]@{ expression = $normalizedLicense })
        }
        $component
    }
)

$dependencies = New-Object System.Collections.Generic.List[object]
[string[]] $rootDependencies = @($collectorRootPurl, $verifierRootPurl)
[System.Array]::Sort($rootDependencies, [System.StringComparer]::Ordinal)
$dependencies.Add([ordered]@{ ref = $productRef; dependsOn = $rootDependencies })
foreach ($purl in $purls) {
    [string[]] $dependsOn = @($dependencySets[$purl].Keys)
    [System.Array]::Sort($dependsOn, [System.StringComparer]::Ordinal)
    $dependencies.Add([ordered]@{ ref = $purl; dependsOn = $dependsOn })
}

$timestamp = [System.DateTimeOffset]::FromUnixTimeSeconds($SourceDateEpoch).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
$document = [ordered]@{
    bomFormat = "CycloneDX"
    specVersion = "1.5"
    version = 1
    metadata = [ordered]@{
        timestamp = $timestamp
        component = [ordered]@{
            type = "application"
            'bom-ref' = $productRef
            name = "WhatsApp Field Collector portable release"
            version = [string] $packageByPurl[$collectorRootPurl].version
        }
        properties = @(
            [ordered]@{ name = "wafc:target"; value = "x86_64-pc-windows-msvc" },
            [ordered]@{ name = "wafc:dependencyScope"; value = "reachable non-dev Cargo dependencies from both release binaries" }
        )
    }
    components = $components
    dependencies = @($dependencies | ForEach-Object { $_ })
}

$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$licensesFullPath = [System.IO.Path]::GetFullPath($ThirdPartyLicensesPath)
if ([string]::Equals($outputFullPath, $licensesFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "SBOM and third-party license bundle output paths must be different"
}
foreach ($candidateOutput in @($outputFullPath, $licensesFullPath)) {
    $parent = Split-Path -Parent $candidateOutput
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Output parent does not exist: $parent"
    }
    Assert-NoReparseComponents -Path $parent -RequireExisting
    Assert-NoReparseComponents -Path $candidateOutput
}
$json = ($document | ConvertTo-Json -Depth 16).Replace("`r`n", "`n") + "`n"
$encoding = New-Object System.Text.UTF8Encoding($false)

$licenseBundle = New-Object System.Text.StringBuilder
[void] $licenseBundle.Append("THIRD-PARTY LICENSES AND NOTICES`n")
[void] $licenseBundle.Append("WhatsApp Field Collector portable release`n")
[void] $licenseBundle.Append("Generated from reachable non-development Cargo dependencies for x86_64-pc-windows-msvc.`n")
[void] $licenseBundle.Append("First-party AGPL-3.0-only workspace packages are intentionally excluded from this bundle.`n")
[void] $licenseBundle.Append("Legacy bare ID/ID Cargo expressions are normalized to SPDX OR; all other slash syntax and SPDX exceptions are rejected.`n")
[void] $licenseBundle.Append("SPDX identifiers/operators are ordinal case-sensitive; every package must provide a non-empty declared, root-level, LICENSES/, or exact-version audited override license text.`n")
[void] $licenseBundle.Append("Allowed third-party SPDX identifiers: 0BSD, Apache-2.0, BSD-1-Clause, BSD-2-Clause, BSD-3-Clause, BSL-1.0, CC0-1.0, ISC, MIT, Unicode-3.0, Unlicense, Zlib.`n")
foreach ($purl in $purls) {
    if ($firstPartyPurls.ContainsKey($purl)) {
        continue
    }
    $package = $packageByPurl[$purl]
    $packageLabel = "$($package.name)@$($package.version)"
    $normalizedLicense = ConvertTo-NormalizedSpdxExpression `
        -Expression ([string] $package.license) `
        -PackageLabel $packageLabel
    $licenseFiles = @(Get-PackageLicenseFiles -Package $package -PackageLabel $packageLabel)
    Assert-SafeBundleField -Value $packageLabel -Field "package label" -MaxLength 256
    Assert-SafeBundleField -Value $purl -Field "$packageLabel PURL" -MaxLength 1024
    Assert-SafeBundleField -Value $normalizedLicense -Field "$packageLabel license expression" -MaxLength 512

    [void] $licenseBundle.Append("`n================================================================================`n")
    [void] $licenseBundle.Append("Package: $packageLabel`n")
    [void] $licenseBundle.Append("PURL: $purl`n")
    [void] $licenseBundle.Append("License: $normalizedLicense`n")
    if ($null -ne $package.repository -and -not [string]::IsNullOrWhiteSpace([string] $package.repository)) {
        $repository = [string] $package.repository
        Assert-SafeBundleField -Value $repository -Field "$packageLabel repository"
        [void] $licenseBundle.Append("Repository: $repository`n")
    }
    foreach ($licenseFile in $licenseFiles) {
        [void] $licenseBundle.Append("`n--- $($licenseFile.RelativePath) ---`n")
        [void] $licenseBundle.Append($licenseFile.Text)
        [void] $licenseBundle.Append("`n")
    }
}

[System.IO.File]::WriteAllText($outputFullPath, $json, $encoding)
[System.IO.File]::WriteAllText($licensesFullPath, $licenseBundle.ToString(), $encoding)
