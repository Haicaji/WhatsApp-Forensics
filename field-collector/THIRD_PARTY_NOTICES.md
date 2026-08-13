# Third-Party Notices

The portable distribution contains independently built `field-collector` and
`waeb-verify` programs. First-party workspace code is licensed under
`AGPL-3.0-only` and is covered by the separately distributed project `LICENSE`;
it is not duplicated in the third-party license bundle.

`THIRD_PARTY_LICENSES.txt` is generated at release time from the complete set of
reachable non-development Cargo dependencies for the
`x86_64-pc-windows-msvc` target. For every third-party package it records the
exact name, version, PURL, normalized SPDX expression, repository when declared,
and the complete declared license file, root-level license/copying/unlicense
texts, root-level notices/copyright files, and files beneath a root-level
`LICENSES/` directory present in the locally resolved Cargo source. Packages are
ordered by PURL and files by case-sensitive relative path so the output is
deterministic. Notice and copyright files are supplemental: every package must
also provide at least one non-empty license-bearing text.

If an exact locked crate declares an approved SPDX expression but its published
archive omits every license text, the release may use only an audited override
listed by exact package name, version, SPDX expression, relative path and
SHA-256 in the generator. Overrides are committed under
`third_party/license-overrides/`, included in source provenance and emitted with
an `AUDITED_OVERRIDE/` path. Current mappings cover the standard `BSL-1.0` text
for `clipboard-win 5.4.1` and the standard `Apache-2.0` text for exact locked
GUI packages whose crate archives omit their repository-root license. For
`MIT OR Apache-2.0` packages this release explicitly selects the Apache
alternative. Exact AccessKit mappings additionally include its Chromium-derived
BSD notice as a supplemental, independently hashed file. Future versions do not
inherit any mapping.

The release fails closed if a reachable third-party package:

- has missing or syntactically invalid Cargo license metadata;
- uses an unknown, copyleft, source-available, or otherwise unapproved license;
- uses an unreviewed SPDX exception;
- lacks a readable, non-empty declared, root-level, `LICENSES/`, or exact-version audited license text;
  or
- supplies an empty, reparse-point, oversized, or non-UTF-8 license/notice file,
  directory, or path component.

To bound release-time resource use, each package is limited to 128 collected
license/notice files, 512 scanned entries beneath `LICENSES/`, 2 MiB per file,
and 8 MiB in aggregate. Bundle metadata fields reject C0/DEL control characters
and enforce bounded lengths so package metadata cannot inject bundle structure.

Legacy Cargo expressions consisting solely of slash-separated SPDX identifiers,
such as `MIT/Apache-2.0` and `Unlicense/MIT`, are normalized to SPDX `OR`
expressions. No other slash syntax is accepted.

SPDX identifiers and operators are parsed with ordinal, case-sensitive
comparison. Lowercase spellings such as `mit` or `or` are rejected rather than
silently rewritten.

The reviewed third-party SPDX identifiers are `0BSD`, `Apache-2.0`,
`BSD-1-Clause`, `BSD-2-Clause`, `BSD-3-Clause`, `BSL-1.0`, `CC0-1.0`, `ISC`,
`MIT`, `Unicode-3.0`, `Unlicense`, and `Zlib`. Every identifier present in an
`AND` or `OR` expression must be on this list; an allowed alternative does not
hide a disallowed identifier. First-party workspace packages must declare
exactly `AGPL-3.0-only`.

The exact graph and normalized expressions are also recorded in
`SBOM.cdx.json`. Authoritative dependency versions are pinned by the two
`Cargo.lock` files in the corresponding source release. A lockfile or dependency
graph change requires regenerating and reviewing both artifacts.

No upstream author endorses this project. This notice is informational and is
not legal advice.
