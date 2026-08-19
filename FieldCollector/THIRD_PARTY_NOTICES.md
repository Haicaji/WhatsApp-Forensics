# Third-party reference notice

The extraction approach in `extractor/src` was informed by the archived
`tmp/原型归档/ZAPiXWEB` prototype and its history-loading regression tests.
ZAPiXWEB is licensed under GNU GPL version 3 and attributes the original work to
Alberto Magno / kraftdenker.

This prototype does not load or import the archived script at runtime. The new
implementation retains the same high-level ideas—WhatsApp Web model discovery,
Store history loading, verified UI fallback, and media decryption fallback—while
using a pull/ACK transport and JSON directory writer of its own.

## Noto Sans CJK SC

The native UI embeds `assets/fonts/NotoSansCJKsc-Regular.otf` from the
[Noto CJK project](https://github.com/notofonts/noto-cjk). The font is licensed
under the SIL Open Font License, Version 1.1. The complete license text is kept
at `assets/fonts/LICENSE-NOTO-SANS-CJK.txt`.

Bundled font SHA-256:
`2C76254F6FC379FDDFCE0A7E84FB5385BB135D3E399294F6EEB6680D0365B74B`.
