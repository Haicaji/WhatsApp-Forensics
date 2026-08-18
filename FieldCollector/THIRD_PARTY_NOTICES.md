# Third-party reference notice

The extraction approach in `extractor/src` was informed by the archived
`tmp/原型归档/ZAPiXWEB` prototype and its history-loading regression tests.
ZAPiXWEB is licensed under GNU GPL version 3 and attributes the original work to
Alberto Magno / kraftdenker.

This prototype does not load or import the archived script at runtime. The new
implementation retains the same high-level ideas—WhatsApp Web model discovery,
Store history loading, verified UI fallback, and media decryption fallback—while
using a pull/ACK transport and JSON directory writer of its own.

