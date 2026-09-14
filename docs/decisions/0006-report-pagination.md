# 0006. Freeform report pagination and PDF

Status: accepted

Reports use a band model: title, column header, row, footer. Page size is US Letter in points (612 by 792) with a 72 point margin. Row height is 18 points. Overflow starts a new page. Footer text is `Page N of M`.

The spike PDF is a deterministic Type1 Courier document. No creation dates, no object UUIDs, no compressed object streams. Two runs of the work-order fixture (45 rows) produce identical bytes and two pages.

Phase 3 can swap the byte writer for a richer engine if the layout math stays in this paginator. Golden files compare bytes on each OS. If a future engine injects platform fonts, pin a bundled font and keep clocks out of the file.

Proof lives in `pagination_is_stable_for_the_spike_fixture` and `pdf_bytes_are_byte_identical_across_runs`.
