//! Variables for opt-in tests. A test that needs a PostgreSQL server, 1.5 GB of
//! disk or a quiet machine is `#[ignore]`d with the reason, so a plain `cargo test`
//! lists it as ignored rather than passed. The CI jobs that provide its variable run
//! it through `scripts/ci/run-ignored-rust-tests.mjs`, which fails unless every
//! ignored test the filter selects ran and passed. Run without its variable, such a
//! test returns early with a message locally and panics under CI (`CI` set), so a
//! CI job can never pass it without running it.

/// Reports a missing variable: a panic under CI, a message otherwise.
fn missing(name: &str) {
    if std::env::var_os("CI").is_some() {
        panic!("{name} is not set; the CI job running this test must provide it");
    }
    eprintln!("skipped: set {name} to run this test");
}

/// A non-empty variable, or `None` after `missing`.
pub(crate) fn var(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => {
            missing(name);
            None
        }
    }
}

/// True when `name` is `1`; otherwise `missing` and false.
pub(crate) fn flag(name: &str) -> bool {
    if std::env::var(name).as_deref() == Ok("1") {
        return true;
    }
    missing(name);
    false
}

/// `IXTABLE_TEST_POSTGRES_URL`, the PostgreSQL server of the PostgreSQL tests.
pub(crate) fn postgres_url() -> Option<String> {
    var("IXTABLE_TEST_POSTGRES_URL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_variable_fails_under_ci_and_skips_elsewhere() {
        let name = "IXTABLE_TEST_ENV_NEVER_SET";
        let ci = std::env::var_os("CI").is_some();
        let outcome = std::panic::catch_unwind(|| (var(name), flag(name)));
        match outcome {
            Ok(result) => {
                assert!(!ci, "a missing variable passed under CI");
                assert_eq!(result, (None, false));
            }
            Err(_) => assert!(ci, "a missing variable panicked outside CI"),
        }
    }
}
