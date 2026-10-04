//! Streaming payload I/O: hashing adapters and zstd streams split into
//! `contents` + `payload_chunks` rows (see the format notes in `archive_io`).
use super::CHUNK_BYTES;
use crate::archive::ArchiveError;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};

/// Counts bytes and SHA-256 of everything read through it.
pub struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
    pub bytes: u64,
}
impl<R: Read> HashingReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }
    pub fn hex(&self) -> String {
        format!("{:x}", self.hasher.clone().finalize())
    }
}
impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}

/// Counts bytes and SHA-256 of everything written through it; remembers sink failures.
pub struct HashingWriter<W> {
    inner: W,
    hasher: Sha256,
    pub bytes: u64,
    pub sink_failed: bool,
}
impl<W: Write> HashingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
            sink_failed: false,
        }
    }
    pub fn hex(&self) -> String {
        format!("{:x}", self.hasher.clone().finalize())
    }
    pub fn into_inner(self) -> W {
        self.inner
    }
}
impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self
            .inner
            .write(buf)
            .inspect_err(|_| self.sink_failed = true)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush().inspect_err(|_| self.sink_failed = true)
    }
}

/// Splits a compressed stream into a first chunk (returned) and `payload_chunks` rows.
struct ChunkWriter<'c> {
    conn: &'c Connection,
    owner: String,
    first: Option<Vec<u8>>,
    buf: Vec<u8>,
    seq: i64,
}
impl<'c> ChunkWriter<'c> {
    fn new(conn: &'c Connection, owner: &str) -> Self {
        Self {
            conn,
            owner: owner.into(),
            first: None,
            buf: Vec::new(),
            seq: 0,
        }
    }
    fn emit(&mut self, chunk: Vec<u8>) -> io::Result<()> {
        if self.first.is_none() {
            self.first = Some(chunk);
            return Ok(());
        }
        self.seq += 1;
        self.conn
            .execute(
                "INSERT INTO payload_chunks(owner,seq,contents) VALUES(?1,?2,?3)",
                params![self.owner, self.seq, chunk],
            )
            .map(|_| ())
            .map_err(io::Error::other)
    }
    fn finish(mut self) -> io::Result<Vec<u8>> {
        let rest = std::mem::take(&mut self.buf);
        if !rest.is_empty() || self.first.is_none() {
            self.emit(rest)?;
        }
        Ok(self.first.take().unwrap_or_default())
    }
}
impl Write for ChunkWriter<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        while self.buf.len() >= CHUNK_BYTES {
            let rest = self.buf.split_off(CHUNK_BYTES);
            let chunk = std::mem::replace(&mut self.buf, rest);
            self.emit(chunk)?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reads a payload's first chunk, then its `payload_chunks` continuation rows.
struct ChunkReader<'c> {
    conn: &'c Connection,
    owner: String,
    chunked: bool,
    buf: Vec<u8>,
    pos: usize,
    seq: i64,
}
impl Read for ChunkReader<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.pos == self.buf.len() {
            if !self.chunked {
                return Ok(0);
            }
            self.seq += 1;
            let next: Option<Vec<u8>> = self
                .conn
                .query_row(
                    "SELECT contents FROM payload_chunks WHERE owner=?1 AND seq=?2",
                    params![self.owner, self.seq],
                    |r| r.get(0),
                )
                .optional()
                .map_err(io::Error::other)?;
            match next {
                Some(chunk) => {
                    self.buf = chunk;
                    self.pos = 0;
                }
                None => self.chunked = false,
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Compresses `src` into chunks owned by `owner`; returns (first chunk, checksum, size).
pub(super) fn write_payload(
    conn: &Connection,
    owner: &str,
    src: &mut dyn Read,
) -> Result<(Vec<u8>, String, u64), ArchiveError> {
    let mut hashing = HashingReader::new(src);
    let mut encoder = zstd::stream::write::Encoder::new(ChunkWriter::new(conn, owner), 3)?;
    io::copy(&mut hashing, &mut encoder)?;
    let first = encoder.finish()?.finish()?;
    Ok((first, hashing.hex(), hashing.bytes))
}

/// Decompresses a payload into `out`, verifying its size and checksum.
pub(super) fn read_payload(
    conn: &Connection,
    chunked: bool,
    owner: &str,
    first: Vec<u8>,
    expected: (&str, i64),
    out: &mut dyn Write,
    label: &str,
) -> Result<(), ArchiveError> {
    let reader = ChunkReader {
        conn,
        owner: owner.into(),
        chunked,
        buf: first,
        pos: 0,
        seq: 0,
    };
    let mut decoder = zstd::stream::read::Decoder::new(reader)
        .map_err(|e| ArchiveError::Corrupt(format!("{label}: {e}")))?;
    let mut sink = HashingWriter::new(out);
    if let Err(e) = io::copy(&mut decoder, &mut sink) {
        return Err(if sink.sink_failed {
            ArchiveError::Io(e)
        } else {
            ArchiveError::Corrupt(format!("{label}: {e}"))
        });
    }
    if sink.bytes as i64 != expected.1 || sink.hex() != expected.0 {
        return Err(ArchiveError::Corrupt(format!(
            "{label} checksum or size mismatch"
        )));
    }
    Ok(())
}
