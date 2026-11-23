# Third-party notices

Formagic ships the following libraries unmodified, in their minified distribution form.

| Library | Version | Location | License |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.5.438 | `lib/pdfjs/` | Apache License 2.0 — [`lib/pdfjs/LICENSE`](lib/pdfjs/LICENSE) |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (fork of [pdf-lib](https://github.com/Hopding/pdf-lib)) | 2.11.1 | `lib/pdf-lib/` | MIT License — [`lib/pdf-lib/LICENSE.md`](lib/pdf-lib/LICENSE.md) |
| [Tesseract.js](https://github.com/naptha/tesseract.js) (`tesseract.js`, `dist/`) | 7.0.0 | `lib/tesseract/` | Apache License 2.0 — [`lib/tesseract/LICENSE`](lib/tesseract/LICENSE) |
| [Tesseract.js-core](https://github.com/naptha/tesseract.js-core) (Tesseract OCR compiled to WebAssembly, LSTM builds) | 7.0.0 | `lib/tesseract/core/` | Apache License 2.0 — [`lib/tesseract/core/LICENSE`](lib/tesseract/core/LICENSE) |
| French trained model `fra` (`@tesseract.js-data/fra`, from [tessdata_best](https://github.com/tesseract-ocr/tessdata_best), integer version) | 4.0.0_best_int | `lib/tesseract/lang/` | Apache License 2.0 (model data); MIT (npm packaging) |

The `@cantoo/pdf-lib` bundle includes its own dependencies (such as pako and fontkit), each under a permissive
license (MIT / zlib); see the package on npm for details.

The Tesseract.js worker bundle includes its own dependencies (such as zlib.js, regenerator-runtime,
wasm-feature-detect and the browser `buffer` module), each under a permissive license (MIT / BSD / Apache 2.0).

The PDF.js distribution also contains CMaps, ICC profiles and standard fonts (`lib/pdfjs/cmaps`, `iccs`,
`standard_fonts`) under the licenses provided by their respective authors, as distributed by Mozilla.
