# Audited license-text overrides

This directory is used only when an exact, locked third-party crate declares an
approved SPDX license but its published crate archive omits every license text.
`scripts/New-CargoSbom.ps1` accepts an override only for an exact package name,
version, SPDX expression, relative path, and SHA-256 fixed in the script. It
rejects all unlisted packages and any changed file.

`clipboard-win 5.4.1` declares `BSL-1.0`, but its crate include list contains no
license file. The checked-in `LICENSE` is the unmodified standard Boost Software
License 1.0 text. The upstream project is
<https://github.com/DoumanAsh/clipboard-win>; the canonical license description
is available from <https://www.boost.org/users/license.html>.

The exact GUI dependency versions listed in `New-CargoSbom.ps1` also omit the
repository-root license from their published crate archives. For packages
declared `MIT OR Apache-2.0`, this distribution selects the `Apache-2.0`
alternative; packages declared only `Apache-2.0` use the same unmodified
standard text. No package with another expression can use that file.

The exact AccessKit versions listed in the script use that Apache-2.0 text as
their primary redistribution license. AccessKit also states that significant
portions are derived from Chromium, so its unmodified `LICENSE.chromium` notice
is included as a supplemental notice. Both files are pinned independently by
SHA-256; a future AccessKit version must be audited and listed separately.

An override supplies a missing notice for redistribution. It does not change a
package's declared license, bypass the SPDX allowlist, or permit future versions.
