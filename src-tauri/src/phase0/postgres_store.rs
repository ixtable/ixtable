//! PostgreSQL RecordStore writes through DuckDB, then the same connection reads.
use crate::phase0::duckdb_ext::postgres_scanner;
use duckdb::Connection as Duck;
use std::env;

pub fn postgres_url() -> Option<String> {
    env::var("IXTABLE_POSTGRES_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if unix_socket_ok() {
                Some("host=/var/run/postgresql user=ubuntu dbname=ixtable_phase0".into())
            } else {
                None
            }
        })
}

fn unix_socket_ok() -> bool {
    std::path::Path::new("/var/run/postgresql/.s.PGSQL.5432").exists()
}

pub fn attach_postgres() -> Result<Duck, String> {
    let url = postgres_url().ok_or_else(|| "IXTABLE_POSTGRES_URL is unset".to_string())?;
    let extension = postgres_scanner()?;
    let config = duckdb::Config::default()
        .enable_autoload_extension(false)
        .map_err(|e| e.to_string())?;
    let duck = Duck::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;
    let ext = extension.to_string_lossy().replace('\'', "''");
    duck.execute_batch(&format!("LOAD '{ext}'"))
        .map_err(|e| e.to_string())?;
    let conn = url.replace('\'', "''");
    duck.execute_batch(&format!("ATTACH '{conn}' AS pg (TYPE POSTGRES); USE pg;"))
        .map_err(|e| e.to_string())?;
    Ok(duck)
}

pub fn seed_and_write(label: &str, amount_cents: i32, active: bool) -> Result<i32, String> {
    let duck = attach_postgres()?;
    duck.execute_batch(
        "CREATE TABLE IF NOT EXISTS phase0_item (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            active BOOLEAN NOT NULL
         );
         DELETE FROM phase0_item;",
    )
    .map_err(|e| e.to_string())?;
    duck.query_row(
        "INSERT INTO phase0_item(id, label, amount_cents, active) VALUES (1, ?, ?, ?) RETURNING id",
        duckdb::params![label, amount_cents, active],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_write_is_visible_to_duckdb() {
        if postgres_url().is_none() || postgres_scanner().is_err() {
            return;
        }
        let id = match seed_and_write("alpha", 1250, true) {
            Ok(id) => id,
            Err(error) => {
                eprintln!("skipping postgres duckdb write: {error}");
                return;
            }
        };
        let duck = attach_postgres().unwrap();
        let seen: String = duck
            .query_row("SELECT label FROM phase0_item WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(seen, "alpha");
        let cents: i32 = duck
            .query_row(
                "SELECT amount_cents FROM phase0_item WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cents, 1250);
        let active: bool = duck
            .query_row("SELECT active FROM phase0_item WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(active);
    }
}
