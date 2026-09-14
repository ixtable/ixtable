//! Deterministic freeform report pagination and PDF bytes.
//!
//! Layout is a list of bands with fixed heights. Overflow starts a new page.
//! PDF output contains no clocks or random IDs.

pub const PAGE_HEIGHT: u32 = 792;
pub const PAGE_WIDTH: u32 = 612;
pub const MARGIN: u32 = 72;
pub const HEADER_HEIGHT: u32 = 36;
pub const ROW_HEIGHT: u32 = 18;

#[derive(Debug, Clone, PartialEq)]
pub struct ReportBand {
    pub kind: BandKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BandKind {
    Title,
    Header,
    Row,
    Footer,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub number: u32,
    pub bands: Vec<ReportBand>,
}

pub fn paginate(title: &str, headers: &[&str], rows: &[Vec<String>]) -> Vec<Page> {
    let usable = PAGE_HEIGHT - (MARGIN * 2) - HEADER_HEIGHT - ROW_HEIGHT;
    let rows_per_page = (usable / ROW_HEIGHT).max(1) as usize;
    let mut pages = Vec::new();
    let total = rows.chunks(rows_per_page).len().max(1) as u32;
    for (index, chunk) in rows.chunks(rows_per_page).enumerate() {
        let number = index as u32 + 1;
        let mut bands = vec![
            ReportBand {
                kind: BandKind::Title,
                text: title.into(),
            },
            ReportBand {
                kind: BandKind::Header,
                text: headers.join(" | "),
            },
        ];
        for row in chunk {
            bands.push(ReportBand {
                kind: BandKind::Row,
                text: row.join(" | "),
            });
        }
        bands.push(ReportBand {
            kind: BandKind::Footer,
            text: format!("Page {number} of {total}"),
        });
        pages.push(Page { number, bands });
    }
    if pages.is_empty() {
        pages.push(Page {
            number: 1,
            bands: vec![
                ReportBand {
                    kind: BandKind::Title,
                    text: title.into(),
                },
                ReportBand {
                    kind: BandKind::Footer,
                    text: "Page 1 of 1".into(),
                },
            ],
        });
    }
    pages
}

pub fn render_pdf(pages: &[Page]) -> Vec<u8> {
    let mut content_objects = Vec::new();
    let mut pages_kids = Vec::new();
    let mut next_id = 3u32;
    for page in pages {
        let mut stream = String::from("BT /F1 12 Tf 72 720 Td\n");
        for (i, band) in page.bands.iter().enumerate() {
            if i > 0 {
                stream.push_str("0 -18 Td\n");
            }
            stream.push_str(&format!("({}) Tj\n", pdf_escape(&band.text)));
        }
        stream.push_str("ET\n");
        let stream_id = next_id;
        next_id += 1;
        let page_id = next_id;
        next_id += 1;
        content_objects.push(format!(
            "{stream_id} 0 obj << /Length {} >> stream\n{stream}endstream\nendobj\n",
            stream.len()
        ));
        pages_kids.push(page_id);
        content_objects.push(format!(
            "{page_id} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] /Contents {stream_id} 0 R /Resources << /Font << /F1 1 0 R >> >> >> endobj\n"
        ));
    }
    let kids = pages_kids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut pdf = String::from("%PDF-1.4\n");
    pdf.push_str("1 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj\n");
    pdf.push_str(&format!(
        "2 0 obj << /Type /Pages /Count {} /Kids [{kids}] >> endobj\n",
        pages.len()
    ));
    for object in content_objects {
        pdf.push_str(&object);
    }
    let catalog_id = next_id;
    pdf.push_str(&format!(
        "{catalog_id} 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    ));
    pdf.push_str(&format!("trailer << /Root {catalog_id} 0 R >>\n%%EOF\n"));
    pdf.into_bytes()
}

fn pdf_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_rows() -> Vec<Vec<String>> {
        (1..=45)
            .map(|i| vec![format!("WO-{i:03}"), format!("Item {i}"), "Open".into()])
            .collect()
    }

    #[test]
    fn pagination_is_stable_for_the_spike_fixture() {
        let pages = paginate("Work orders", &["Id", "Name", "Status"], &fixture_rows());
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].bands[0].text, "Work orders");
        assert_eq!(pages[0].number, 1);
        assert_eq!(pages[1].number, 2);
        assert!(pages[0].bands.iter().any(|b| b.text == "WO-001 | Item 1 | Open"));
        assert!(pages[1].bands.iter().any(|b| b.text.contains("WO-045")));
        assert_eq!(pages[0].bands.last().unwrap().text, "Page 1 of 2");
        let again = paginate("Work orders", &["Id", "Name", "Status"], &fixture_rows());
        assert_eq!(pages, again);
    }

    #[test]
    fn pdf_bytes_are_byte_identical_across_runs() {
        let pages = paginate("Work orders", &["Id", "Name", "Status"], &fixture_rows());
        let a = render_pdf(&pages);
        let b = render_pdf(&pages);
        assert_eq!(a, b);
        let text = String::from_utf8(a).unwrap();
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.contains("WO-001 | Item 1 | Open"));
        assert!(text.contains("Page 2 of 2"));
        assert!(!text.contains("CreationDate"));
    }
}
