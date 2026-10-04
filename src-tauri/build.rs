fn main() {
    if std::env::var_os("CARGO_FEATURE_TEST_BRIDGE").is_some() {
        napi_build::setup();
        // The test bridge DLL is loaded by node.exe, which has no Common Controls v6
        // manifest, so comctl32 v5 is bound and its missing TaskDialogIndirect import
        // (tauri-runtime-wry and rfd dialogs) fails the load with error 127. Delay-load
        // comctl32 so the import resolves only if a dialog is ever shown (never in tests).
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            println!("cargo:rustc-link-arg-cdylib=/DELAYLOAD:comctl32.dll");
            println!("cargo:rustc-link-arg-cdylib=delayimp.lib");
        }
    }
    // DuckDB loads the signed sqlite/postgres scanner extensions with dlopen; on Linux they resolve DuckDB symbols from the host executable, which must export them.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,--export-dynamic");
    }
    tauri_build::build()
}
