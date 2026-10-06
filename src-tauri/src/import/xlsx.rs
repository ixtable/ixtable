//! XLSX worksheets through calamine. Column types are inferred from the cell
//! types: whole numbers become integers, Excel dates become dates (or
//! timestamps when any has a time), and mixed columns become text.
use super::parse::{unique_names, ParseOptions, ParsedFile, SourceColumn};
use crate::data::files::FileFormat;
use crate::data::{logical, DataValue, LogicalType};
use calamine::{open_workbook, Data, Reader, Xlsx};
use std::path::Path;

pub fn parse(
    path: &Path,
    options: &ParseOptions,
    limit: Option<usize>,
) -> Result<ParsedFile, String> {
    let mut workbook: Xlsx<_> =
        open_workbook(path).map_err(|e| format!("Could not read the workbook: {e}"))?;
    let sheets = workbook.sheet_names();
    let sheet = options
        .sheet
        .clone()
        .or_else(|| sheets.first().cloned())
        .ok_or("The workbook has no worksheets")?;
    let range = workbook
        .worksheet_range(&sheet)
        .map_err(|e| format!("Could not read worksheet {sheet:?}: {e}"))?;
    let width = range.width();
    let mut rows = range.rows();
    let header: Vec<String> = match options.header {
        true => rows
            .next()
            .map(|r| {
                r.iter()
                    .map(|c| cell(c).as_text().unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default(),
        false => vec![],
    };
    let names = unique_names(
        (0..width)
            .map(|i| header.get(i).cloned().unwrap_or_default())
            .collect(),
    );
    let mut data: Vec<Vec<DataValue>> = rows
        .map(|r| {
            (0..width)
                .map(|i| r.get(i).map(cell).unwrap_or(DataValue::Null))
                .collect()
        })
        .filter(|r: &Vec<DataValue>| r.iter().any(|v| *v != DataValue::Null))
        .collect();
    let columns: Vec<SourceColumn> = names
        .into_iter()
        .enumerate()
        .map(|(i, name)| SourceColumn {
            name,
            logical_type: infer(data.iter().map(|r| &r[i])),
        })
        .collect();
    for row in &mut data {
        for (value, column) in row.iter_mut().zip(&columns) {
            if let Ok(v) = column.logical_type.normalize(&column.name, value) {
                *value = v;
            }
        }
    }
    let total_rows = data.len() as u64;
    if let Some(n) = limit {
        data.truncate(n);
    }
    Ok(ParsedFile {
        format: FileFormat::Xlsx,
        columns,
        rows: data,
        total_rows,
        sheets,
    })
}

fn cell(c: &Data) -> DataValue {
    match c {
        Data::Empty => DataValue::Null,
        Data::Int(v) => DataValue::Integer(*v),
        Data::Float(v) => DataValue::Real(*v),
        Data::Bool(v) => DataValue::Boolean(*v),
        Data::String(s) if s.trim().is_empty() => DataValue::Null,
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => DataValue::Text(s.clone()),
        Data::DateTime(dt) if dt.is_datetime() => {
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
        Data::DateTime(dt) => DataValue::Text(dt.to_string()),
        Data::Error(e) => DataValue::Text(format!("#{e:?}")),
    }
}

/// The narrowest logical type that holds every non-null value of a column.
pub fn infer<'a>(values: impl Iterator<Item = &'a DataValue>) -> LogicalType {
    let (mut ints, mut reals, mut bools, mut dates, mut stamps, mut other) = (0, 0, 0, 0, 0, 0);
    let mut fractional = false;
    for v in values {
        match v {
            DataValue::Null => {}
            DataValue::Integer(_) => ints += 1,
            DataValue::Real(r) => {
                reals += 1;
                fractional |= r.fract() != 0.0 || r.abs() >= 9.0e15;
            }
            DataValue::Boolean(_) => bools += 1,
            DataValue::Date(_) => dates += 1,
            DataValue::Timestamp(_) => stamps += 1,
            _ => other += 1,
        }
    }
    let kinds = [ints + reals, bools, dates + stamps, other];
    if kinds.iter().filter(|n| **n > 0).count() != 1 {
        return LogicalType::Text;
    }
    match () {
        _ if ints + reals > 0 && fractional => LogicalType::Real,
        _ if ints + reals > 0 => LogicalType::Integer,
        _ if bools > 0 => LogicalType::Boolean,
        _ if stamps > 0 => LogicalType::Timestamp,
        _ if dates > 0 => LogicalType::Date,
        _ => LogicalType::Text,
    }
}
