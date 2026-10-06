# Report fonts

The report PDF writer embeds subsets of these fonts for characters that the
standard Helvetica fonts can't show (see `docs/decisions/report-engine.md`).
They are compiled into the app (`src-tauri/src/report_pdf.rs`), so PDF output
never depends on the fonts installed on the machine.

| File | Version | Covers | License |
|---|---|---|---|
| `DejaVuSans.ttf` | DejaVu 2.37 | Latin, Greek, Cyrillic, symbols | Bitstream Vera / public domain (`LICENSE-DejaVu.txt`) |
| `DroidSansFallbackFull.ttf` | AOSP | CJK ideographs, kana | Apache License 2.0 (`LICENSE-DroidSansFallback.txt`) |

Changing either file changes report layout. Regenerate the width table with
`UPDATE_GOLDENS=1 cargo test --lib report_pdf` and review the golden diffs.
