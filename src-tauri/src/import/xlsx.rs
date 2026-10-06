//! XLSX worksheets through calamine's streaming cell reader, so memory does
//! not grow with the sheet's used range. Column types are inferred from the
//! cell types: whole numbers become integers, Excel dates become dates (or
//! timestamps when any has a time), and mixed columns become text.
use super::parse::{unique_names, ParseOptions, ParsedFile, SourceColumn};
use crate::data::files::FileFormat;
use crate::data::{logical, DataValue, LogicalType};
use calamine::{open_workbook, DataRef, Reader, Xlsx};
use std::collections::BTreeMap;
use std::path::Path;

/// Most columns a worksheet may span (PostgreSQL's limit for one table).
pub const MAX_COLUMNS: u32 = 1600;

type Workbook = Xlsx<std::io::BufReader<std::fs::File>>;

/// A worksheet's used columns and header, found by reading it once.
#[derive(Debug, Clone)]
pub struct SheetLayout {
    sheet: String,
    pub names: Vec<String>,
    header_row: Option<u32>,
    first_col: u32,
}

fn open(path: &Path, options: &ParseOptions) -> Result<(Workbook, String, Vec<String>), String> {
    let workbook: Workbook =
        open_workbook(path).map_err(|e| format!("Could not read the workbook: {e}"))?;
    let sheets = workbook.sheet_names();
    let sheet = options
        .sheet
        .clone()
        .or_else(|| sheets.first().cloned())
        .ok_or("The workbook has no worksheets")?;
    Ok((workbook, sheet, sheets))
}

/// Streams the non-empty cells of `sheet` as `(row, column, value)` in file
/// order, never building the whole sheet, so a huge used range costs nothing.
fn cells(
    workbook: &mut Workbook,
    sheet: &str,
    mut f: impl FnMut(u32, u32, DataValue) -> Result<(), String>,
) -> Result<(), String> {
    let error = |e: calamine::XlsxError| format!("Could not read worksheet {sheet:?}: {e}");
    let mut reader = workbook.worksheet_cells_reader(sheet).map_err(error)?;
    while let Some(c) = reader.next_cell().map_err(error)? {
        let (row, col) = c.get_position();
        match cell(c.get_value()) {
            DataValue::Null => {}
            value => f(row, col, value)?,
        }
    }
    Ok(())
}

/// Column bounds of the cells seen so far; refuses sheets wider than `MAX_COLUMNS`.
#[derive(Default)]
struct Bounds {
    first: Option<(u32, u32, u32)>,
}
impl Bounds {
    fn add(&mut self, sheet: &str, row: u32, col: u32) -> Result<(), String> {
        let (_, lo, hi) = self.first.get_or_insert((row, col, col));
        *lo = (*lo).min(col);
        *hi = (*hi).max(col);
        let width = *hi - *lo + 1;
        if width > MAX_COLUMNS {
            return Err(format!(
                "Worksheet {sheet:?} spans more than {MAX_COLUMNS} columns; remove unused columns or copy the data to a new sheet"
            ));
        }
        Ok(())
    }
    fn first_row(&self) -> Option<u32> {
        self.first.map(|(r, _, _)| r)
    }
    fn first_col(&self) -> u32 {
        self.first.map_or(0, |(_, lo, _)| lo)
    }
    fn width(&self) -> usize {
        self.first.map_or(0, |(_, lo, hi)| (hi - lo + 1) as usize)
    }
}

fn names(header: &[(u32, DataValue)], first_col: u32, width: usize) -> Vec<String> {
    let mut raw = vec![String::new(); width];
    for (col, value) in header {
        raw[(col - first_col) as usize] = value.as_text().unwrap_or_default();
    }
    unique_names(raw)
}

/// Reads the sheet once for its columns and header.
pub fn layout(path: &Path, options: &ParseOptions) -> Result<SheetLayout, String> {
    let (mut workbook, sheet, _) = open(path, options)?;
    let mut bounds = Bounds::default();
    let mut header = vec![];
    cells(&mut workbook, &sheet, |row, col, value| {
        bounds.add(&sheet, row, col)?;
        if options.header && bounds.first_row() == Some(row) {
            header.push((col, value));
        }
        Ok(())
    })?;
    let first_col = bounds.first_col();
    Ok(SheetLayout {
        names: names(&header, first_col, bounds.width()),
        header_row: bounds.first_row().filter(|_| options.header),
        first_col,
        sheet,
    })
}

/// Streams each data row (cells as read, not converted) to `f`; returns the row count.
pub fn for_each_row(
    path: &Path,
    layout: &SheetLayout,
    mut f: impl FnMut(Vec<DataValue>) -> Result<(), String>,
) -> Result<u64, String> {
    let (mut workbook, _, _) = open(path, &ParseOptions::default())?;
    let width = layout.names.len();
    let mut current: Option<(u32, Vec<DataValue>)> = None;
    let mut count = 0;
    cells(&mut workbook, &layout.sheet, |row, col, value| {
        let Some(i) = col
            .checked_sub(layout.first_col)
            .map(|i| i as usize)
            .filter(|i| *i < width && Some(row) != layout.header_row)
        else {
            return Ok(());
        };
        if current.as_ref().is_some_and(|(r, _)| *r != row) {
            let (_, done) = current.take().unwrap_or_default();
            count += 1;
            f(done)?;
        }
        current
            .get_or_insert_with(|| (row, vec![DataValue::Null; width]))
            .1[i] = value;
        Ok(())
    })?;
    if let Some((_, done)) = current {
        count += 1;
        f(done)?;
    }
    Ok(count)
}

/// Reads the sheet once: suggested types from every cell, the first `limit`
/// rows (converted to those types), and the row count.
pub fn preview(path: &Path, options: &ParseOptions, limit: usize) -> Result<ParsedFile, String> {
    let (mut workbook, sheet, sheets) = open(path, options)?;
    let mut bounds = Bounds::default();
    let mut header = vec![];
    let mut kinds: BTreeMap<u32, Kinds> = BTreeMap::new();
    let mut sparse: Vec<Vec<(u32, DataValue)>> = vec![];
    let (mut last_row, mut total_rows) = (None, 0u64);
    cells(&mut workbook, &sheet, |row, col, value| {
        bounds.add(&sheet, row, col)?;
        if options.header && bounds.first_row() == Some(row) {
            header.push((col, value));
            return Ok(());
        }
        kinds.entry(col).or_default().add(&value);
        if last_row != Some(row) {
            last_row = Some(row);
            total_rows += 1;
            if sparse.len() < limit {
                sparse.push(vec![]);
            }
        }
        if total_rows as usize <= limit {
            if let Some(r) = sparse.last_mut() {
                r.push((col, value));
            }
        }
        Ok(())
    })?;
    let (first_col, width) = (bounds.first_col(), bounds.width());
    let columns: Vec<SourceColumn> = names(&header, first_col, width)
        .into_iter()
        .enumerate()
        .map(|(i, name)| SourceColumn {
            name,
            logical_type: kinds
                .get(&(first_col + i as u32))
                .map_or(LogicalType::Text, Kinds::logical),
        })
        .collect();
    let rows = sparse
        .into_iter()
        .map(|cells| {
            let mut row = vec![DataValue::Null; width];
            for (col, value) in cells {
                let c = &columns[(col - first_col) as usize];
                row[(col - first_col) as usize] =
                    c.logical_type.normalize(&c.name, &value).unwrap_or(value);
            }
            row
        })
        .collect();
    Ok(ParsedFile {
        format: FileFormat::Xlsx,
        columns,
        rows,
        total_rows,
        sheets,
    })
}

/// A cell as a value; whole numbers (Excel stores them as floats) are integers.
fn cell(c: &DataRef) -> DataValue {
    match c {
        DataRef::Empty => DataValue::Null,
        DataRef::Int(v) => DataValue::Integer(*v),
        DataRef::Float(v) if v.fract() == 0.0 && v.abs() < 9.0e15 => DataValue::Integer(*v as i64),
        DataRef::Float(v) => DataValue::Real(*v),
        DataRef::Bool(v) => DataValue::Boolean(*v),
        DataRef::String(s) | DataRef::DateTimeIso(s) | DataRef::DurationIso(s)
            if s.trim().is_empty() =>
        {
            DataValue::Null
        }
        DataRef::SharedString(s) if s.trim().is_empty() => DataValue::Null,
        DataRef::String(s) | DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => {
            DataValue::Text(s.clone())
        }
        DataRef::SharedString(s) => DataValue::Text((*s).to_string()),
        DataRef::DateTime(dt) if dt.is_datetime() => {
            let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
            let Some(date) = chrono::NaiveDate::from_ymd_opt(y.into(), mo.into(), d.into()) else {
                return DataValue::Text(dt.to_string());
            };
            if (h, mi, s, ms) == (0, 0, 0, 0) {
                return DataValue::Date(date.format("%Y-%m-%d").to_string());
            }
            date.and_hms_milli_opt(h.into(), mi.into(), s.into(), ms.into())
                .map(|t| DataValue::Timestamp(logical::format_timestamp(t)))
                .unwrap_or_else(|| DataValue::Text(dt.to_string()))
        }
        DataRef::DateTime(dt) => DataValue::Text(dt.to_string()),
        DataRef::Error(e) => DataValue::Text(format!("#{e:?}")),
    }
}

/// Counts of the value kinds in one column.
#[derive(Default)]
struct Kinds {
    numbers: u64,
    fractional: bool,
    bools: u64,
    dates: u64,
    stamps: u64,
    other: u64,
}
impl Kinds {
    fn add(&mut self, v: &DataValue) {
        match v {
            DataValue::Null => {}
            DataValue::Integer(_) => self.numbers += 1,
            DataValue::Real(r) => {
                self.numbers += 1;
                self.fractional |= r.fract() != 0.0 || r.abs() >= 9.0e15;
            }
            DataValue::Boolean(_) => self.bools += 1,
            DataValue::Date(_) => self.dates += 1,
            DataValue::Timestamp(_) => self.stamps += 1,
            _ => self.other += 1,
        }
    }
    fn logical(&self) -> LogicalType {
        let kinds = [
            self.numbers,
            self.bools,
            self.dates + self.stamps,
            self.other,
        ];
        if kinds.iter().filter(|n| **n > 0).count() != 1 {
            return LogicalType::Text;
        }
        match () {
            _ if self.numbers > 0 && self.fractional => LogicalType::Real,
            _ if self.numbers > 0 => LogicalType::Integer,
            _ if self.bools > 0 => LogicalType::Boolean,
            _ if self.stamps > 0 => LogicalType::Timestamp,
            _ if self.dates > 0 => LogicalType::Date,
            _ => LogicalType::Text,
        }
    }
}

/// The narrowest logical type that holds every non-null value of a column.
pub fn infer<'a>(values: impl Iterator<Item = &'a DataValue>) -> LogicalType {
    let mut kinds = Kinds::default();
    values.for_each(|v| kinds.add(v));
    kinds.logical()
}
