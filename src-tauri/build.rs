fn main() {
    if std::env::var_os("CARGO_FEATURE_TEST_BRIDGE").is_some() {
        napi_build::setup();
    }
    // DuckDB loads the signed sqlite/postgres scanner extensions with dlopen; on Linux they resolve DuckDB symbols from the host executable, which must export them.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,--export-dynamic");
    }
    tauri_build::build()
}
