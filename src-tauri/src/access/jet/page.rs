//! Page access for Jet/ACE files: the database header, RC4-masked header bytes,
//! Jet page encryption, and table usage maps (`docs/access-format.md` §4.1–4.3).
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

/// Engine version from header byte 0x14.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Version {
    Jet3,
    Jet4,
    /// Access 2007 (0x02), 2010 (0x03), 2016 (0x05), 2019 (0x06).
    Ace(u8),
}

impl Version {
    pub fn jet3(self) -> bool {
        self == Version::Jet3
    }
}

/// The RC4 key Access uses to mask the database header (bytes 0x18..).
pub const HEADER_KEY: u32 = 0x6b39_dac7;

/// RC4 keystream of `len` bytes for a key (little-endian u32 for page keys).
pub fn rc4(key: &[u8], data: &mut [u8]) {
    let mut s: [u8; 256] = std::array::from_fn(|i| i as u8);
    let mut j: u8 = 0;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    let (mut i, mut j) = (0u8, 0u8);
    for b in data.iter_mut() {
        i = i.wrapping_add(1);
        j = j.wrapping_add(s[i as usize]);
        s.swap(i as usize, j as usize);
        *b ^= s[s[i as usize].wrapping_add(s[j as usize]) as usize];
    }
}

pub fn u16_at(b: &[u8], at: usize) -> u16 {
    b.get(at..at + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .unwrap_or(0)
}

pub fn u32_at(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .unwrap_or(0)
}

/// A row pointer: row number in the low byte, page number in the upper three.
pub fn row_pointer(v: u32) -> (u32, usize) {
    (v >> 8, (v & 0xFF) as usize)
}

/// Facts from page 0.
#[derive(Debug, Clone)]
pub struct Header {
    pub version: Version,
    pub page_size: usize,
    /// Windows code page of Jet 3 text.
    pub code_page: u16,
    /// Non-zero when Jet 3/4 pages are RC4-encrypted.
    pub encoding_key: u32,
}

pub fn parse_header(page0: &[u8]) -> Result<Header, String> {
    if page0.len() < 0x80
        || page0[0] != 0
        || &page0[4..19] != b"Standard Jet DB" && &page0[4..19] != b"Standard ACE DB"
    {
        if page0.len() >= 19 && &page0[4..19] == b"MSISAM Database" {
            return Err("Microsoft Money (MSISAM) files are not Access databases".into());
        }
        return Err("not an Access database (no Jet/ACE signature in the header)".into());
    }
    let version = match page0[0x14] {
        0 => Version::Jet3,
        1 => Version::Jet4,
        v @ 2..=6 => Version::Ace(v),
        v => return Err(format!("unknown Access file format code {v}")),
    };
    let mut masked = page0.to_vec();
    let mask_len = if version.jet3() { 126 } else { 128 };
    let mut keystream = vec![0u8; mask_len];
    rc4(&HEADER_KEY.to_le_bytes(), &mut keystream);
    for (i, k) in keystream.iter().enumerate() {
        if let Some(b) = masked.get_mut(0x18 + i) {
            *b ^= k;
        }
    }
    Ok(Header {
        version,
        page_size: if version.jet3() { 2048 } else { 4096 },
        code_page: u16_at(&masked, 0x3C),
        encoding_key: u32_at(&masked, 0x3E),
    })
}

/// Reads pages from a file, decrypting Jet 3/4 pages when the header asks.
pub struct Pages {
    file: File,
    pub header: Header,
    pub page_count: u32,
}

impl Pages {
    pub fn open(mut file: File) -> Result<Self, String> {
        let mut page0 = vec![0u8; 4096];
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let n = file.read(&mut page0).map_err(|e| e.to_string())?;
        page0.truncate(n);
        let header = parse_header(&page0)?;
        if header.encoding_key != 0 && matches!(header.version, Version::Ace(_)) {
            return Err("the database is encrypted with a password; remove the password in Access, then import it".into());
        }
        let page_count = (len / header.page_size as u64) as u32;
        Ok(Self {
            file,
            header,
            page_count,
        })
    }

    pub fn page_size(&self) -> usize {
        self.header.page_size
    }

    pub fn read(&mut self, page: u32) -> Result<Vec<u8>, String> {
        if page >= self.page_count {
            return Err(format!("page {page} is past the end of the file"));
        }
        let size = self.header.page_size;
        let mut buf = vec![0u8; size];
        self.file
            .seek(SeekFrom::Start(page as u64 * size as u64))
            .and_then(|_| self.file.read_exact(&mut buf))
            .map_err(|e| format!("page {page}: {e}"))?;
        if page > 0 && self.header.encoding_key != 0 {
            rc4(&(page ^ self.header.encoding_key).to_le_bytes(), &mut buf);
        }
        Ok(buf)
    }

    /// The bytes of row `row` on `page`, with the deleted and overflow flags.
    pub fn row(&mut self, page: u32, row: usize) -> Result<RawRow, String> {
        let buf = self.read(page)?;
        row_on_page(&buf, row, self.header.version)
            .ok_or_else(|| format!("row {row} on page {page} does not exist"))
    }

    /// Pages owned by a table, from the usage map its TDEF points to.
    pub fn usage_map(&mut self, pointer: u32) -> Result<Vec<u32>, String> {
        let (page, row) = row_pointer(pointer);
        let map = self.row(page, row)?.data;
        let mut pages = vec![];
        match map.first() {
            Some(0) => {
                let start = u32_at(&map, 1);
                collect_bits(&map[5..], start, &mut pages);
            }
            Some(1) => {
                let per_page = ((self.page_size() - 4) * 8) as u32;
                for (i, chunk) in map[1..].chunks_exact(4).enumerate() {
                    let map_page = u32_at(chunk, 0);
                    if map_page == 0 {
                        continue;
                    }
                    let buf = self.read(map_page)?;
                    if buf[0] != 0x05 {
                        return Err(format!("usage map page {map_page} has type {}", buf[0]));
                    }
                    collect_bits(&buf[4..], i as u32 * per_page, &mut pages);
                }
            }
            other => return Err(format!("unknown usage map type {other:?}")),
        }
        Ok(pages)
    }
}

fn collect_bits(bitmap: &[u8], start: u32, out: &mut Vec<u32>) {
    for (i, byte) in bitmap.iter().enumerate() {
        for bit in 0..8 {
            if byte & (1 << bit) != 0 {
                out.push(start + (i * 8 + bit) as u32);
            }
        }
    }
}

/// A row slot of a data page.
#[derive(Debug, Clone)]
pub struct RawRow {
    pub data: Vec<u8>,
    pub deleted: bool,
    /// The row holds only a pointer to the row's new place.
    pub overflow: bool,
}

/// Number of rows on a data page.
pub fn rows_on_page(buf: &[u8], version: Version) -> usize {
    u16_at(buf, if version.jet3() { 8 } else { 12 }) as usize
}

/// Slices row `row` out of a data page: rows grow down from the page end.
pub fn row_on_page(buf: &[u8], row: usize, version: Version) -> Option<RawRow> {
    let base = if version.jet3() { 10 } else { 14 };
    if row >= rows_on_page(buf, version) {
        return None;
    }
    let raw = u16_at(buf, base + row * 2);
    let start = (raw & 0x1FFF) as usize;
    let end = if row == 0 {
        buf.len()
    } else {
        (u16_at(buf, base + (row - 1) * 2) & 0x1FFF) as usize
    };
    if start > end || end > buf.len() {
        return None;
    }
    Some(RawRow {
        data: buf[start..end].to_vec(),
        deleted: raw & 0x8000 != 0,
        overflow: raw & 0x4000 != 0,
    })
}
