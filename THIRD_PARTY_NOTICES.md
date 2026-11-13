# Third-party notices

Formagic ships the following libraries unmodified, in their minified distribution form.

| Library | Version | Location | License |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.5.438 | `lib/pdfjs/` | Apache License 2.0 — [`lib/pdfjs/LICENSE`](lib/pdfjs/LICENSE) |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (fork of [pdf-lib](https://github.com/Hopding/pdf-lib)) | 2.11.1 | `lib/pdf-lib/` | MIT License — [`lib/pdf-lib/LICENSE.md`](lib/pdf-lib/LICENSE.md) |

The `@cantoo/pdf-lib` bundle includes its own dependencies (such as pako and fontkit), each under a permissive
license (MIT / zlib); see the package on npm for details.

The PDF.js distribution also contains CMaps, ICC profiles and standard fonts (`lib/pdfjs/cmaps`, `iccs`,
`standard_fonts`) under the licenses provided by their respective authors, as distributed by Mozilla.
