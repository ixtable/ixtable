# Report engine: deterministic layout and PDF output

Status: accepted. Covers PRD §15, the Phase 0 report pagination spike, and the
§26.5 report golden checks.

## Context

The PRD requires the report engine to paginate reports the same way on Windows,
macOS, and Linux. Preview, print, and PDF output all come from that one model. Report golden files must be deterministic within declared
tolerances. Reports must stay readable when printed without color.

Browser layout cannot give that guarantee. Text width depends on the installed
fonts, the font rasterizer, and the WebView engine. WebView2, WKWebView, and
WebKitGTK all differ, so a line that fits on one machine can wrap on another and
push a row onto the next page.

## Decision

Layout is a pure TypeScript function with no DOM access:

```ts
layoutReport(report, rows, { params, now, tables, assets }) → ReportDocument
```

It lives in `src/reports/engine/` and returns pages of positioned items in
points: `text` with pre-broken lines and baselines, `line`, `rect`, and `image`.
Every renderer draws those items as given. None of them measures or wraps text.

### Fixed font metrics

Text uses the PDF standard fonts Helvetica and Helvetica-Bold. Their advance
widths for every WinAnsi code come from the Adobe Core14 AFM files and ship as a
TypeScript table in `src/reports/engine/metrics.ts`. Wrapping sums integer
widths from that table, so the same string always breaks at the same place.

Characters outside WinAnsi print as `?`. The preview and the PDF show the same
substitution, so the preview never promises a glyph the PDF can't draw.

The on-screen and printed SVG ask for Helvetica, then Arial and Liberation Sans,
which share Helvetica's widths. Each line also sets `textLength` to the engine's
width, so a fallback font is stretched to the computed width instead of spilling
past its box.

### Pagination rules

- Rows sort by the group keys with a stable sort. Keys compare in a fixed order:
  null, booleans, numbers, then text by UTF-16 code unit. Locale never affects
  the order.
- The report header prints once, then for each group a header, the rows, and a
  footer, then the report footer. Group bands see the group's rows as `rows`.
- Page headers and footers print on every page. `page` and `pages` resolve after
  pagination, so `'Page ' & page & ' of ' & pages` is exact.
- A band moves to the next page when it doesn't fit. A band taller than the page
  body prints at the top of a page and overflows.
- `keepTogether` on a band with a table moves the band to the next page instead
  of splitting it. On a group header it also keeps the header on the page of the
  first row that follows.
- A band may hold one table. The table grows past its designed height, and
  components below it move down by the growth. When the table doesn't fit, it
  splits between rows and repeats its header row at the top of each new page.
- `pageBreakBefore` and `pageBreakAfter` on a band start a new page before or
  after each instance of it. A break never leaves a page empty: a break before
  is skipped at the top of a page, and a break after the last band adds no page.
  Page header and footer bands ignore them.
- A group with `newPage` starts every instance on a new page, like a break
  before its header. This holds even when the header band is empty.
- A group with `repeatHeader` prints its header band again at the top of every
  page the group continues on, below the page header, including the pages a
  split table continues on. The repeat sees the group's `rows` and `group`.
  It prints the header's non-table components at the band's designed height;
  a table in the header prints only once. Pagination reserves that height: a
  block that fits a page only without the repeated headers starts a page
  without them, and a `keepTogether` table that doesn't fit below them splits.
- A group with `resetPageNumber` starts every instance on a new page, so the
  designer shows its "starts a new page" option checked and disabled. It also
  restarts `groupPage` and `groupPages` there. They count the pages since the
  last such group start (or since the first page). Without any such group they
  equal `page` and `pages`, and `page` and `pages` always count the whole report.
- `pageBreakBefore`, `pageBreakAfter`, `newPage`, `repeatHeader`, and
  `resetPageNumber` default to off and are left out of the stored definition
  when off, so older reports lay out exactly as before. `keepTogether` is
  always stored.
- Page header and footer bands can't hold a table. The designer lists it as a
  problem and marks Add table `aria-disabled` with a visible reason on those
  bands. `reports::validate` returns a warning, not an error, so older
  documents that hold one still export. Layout leaves the table out and reports
  a diagnostic.
- Text boxes don't grow. Lines past the box height are dropped, and at least one
  line always shows.

### Determinism guarantees and tolerances

The engine uses only integer metric sums and IEEE-754 arithmetic, which
JavaScript evaluates identically on every platform. Output coordinates round to
0.01 pt. The clock is an option, so `today()` and `now()` are fixed in tests.
Expression evaluation goes through `src/expr`, which already rounds arithmetic
to 15 significant digits.

The tolerance for layout goldens is zero: the same report, rows, and options
produce deep-equal page objects. The tolerance for PDF goldens is also zero: the
writer uses a fixed object order, uncompressed content streams, no random file
id, and a `/CreationDate` taken from the options. Studio passes the time the
preview loaded its data, so exporting the same preview twice writes identical
files.

On-screen rendering is not byte-exact, because the WebView draws the glyphs.
Positions and line breaks match the PDF exactly. Glyph shapes can differ when a
fallback font is used.

### PDF writer

`src/reports/pdf.ts` writes PDF 1.4 without dependencies. It references the
standard fonts with WinAnsiEncoding, so nothing is embedded. Strings escape `\`,
`(`, and `)`, and bytes outside printable ASCII are written as octal escapes,
which keeps the file ASCII apart from image streams. Graphics use gray levels
only.

JPEG images pass through unchanged with `DCTDecode`. Non-interlaced grayscale,
RGB, and palette PNGs pass their IDAT data through with `FlateDecode` and the
PNG predictor, so no pixel decoding is needed. Other images print as a crossed
placeholder box.

Rust only stores and validates definitions (`reports::validate`) and writes the
finished bytes (`write_report_pdf`). Rust never evaluates expressions.

### Print

Print renders every page as an SVG sized in points into a container appended to
`<body>`, adds an `@page` rule with the page size and zero margin, and calls
`window.print()`. A print stylesheet hides the app and breaks after each page.

### Grayscale output

Styles carry gray levels, not colors: text gray, border width, and fill gray.
Table headers use a 0.9 gray fill with black text, which stays readable on a
monochrome printer.

## Deferred

PRD §15 defers nested subreports, report scripts, barcodes, label layouts, and
arbitrary HTML or CSS. This engine also leaves these for later:

- fonts other than Helvetica, italic text, and characters outside WinAnsi
- text boxes that grow with their content, and more than one table per band
- PNG images with alpha or interlacing, and formats other than JPEG and PNG,
  which print as placeholders in the PDF
- color
- PDF compression, embedded fonts, and PDF/A

## Proof

- `tests/unit/report-engine.test.ts`: golden layouts for multi-page pagination,
  group breaks, keep-together headers, a table that spans pages, and two-pass
  page numbers.
- `tests/unit/report-pdf.test.ts`: a byte-for-byte golden PDF, xref offset
  checks, string escaping, image passthrough, and two runs giving identical
  bytes.
- `tests/unit/report-pagination.test.ts`: page assignments and positions for
  page breaks, new page per group, repeated group headers (also above a split
  table), group page numbers, and the diagnostic for a table in a page band.
- `tests/integration/golden/report-snapshots.test.tsx`: lays out every report
  of the CRM, Inventory, and Work orders golden apps from their template and
  seed rows, with a fixed clock and `TZ=UTC`, and compares the layout JSON and
  PDF bytes with `tests/fixtures/report-goldens/`. Run it with `UPDATE_GOLDENS=1` to
  rewrite the fixtures after an intended change. Asset ids, which are minted
  when the template is created, are replaced by `{{asset:N}}` in the layout
  JSON. `.gitattributes` keeps the fixtures out of line-ending conversion.
- `tests/integration/report.test.tsx`: builds a grouped report in the UI,
  previews it, prints it, and exports two identical PDFs through the Rust
  command. It also sets the pagination options in the designer and checks that
  Add table is blocked on page header and footer bands.

## Audit log

- 2026-10-05: Said which options are omitted when off (`keepTogether` is
  always stored) and added the page-band table checks to the proof.
