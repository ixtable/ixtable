#[path = "src/release_keys.rs"]
mod release_keys;

/// Beta/stable builds (`IXTABLE_RELEASE=1`, set by release.yml) fail closed on missing or dev
/// keys. Without the opt-in, `tauri build` is a development build.
fn check_release_keys() {
    for var in [
        "IXTABLE_RELEASE",
        "IXTABLE_CLOUD_PUBLIC_KEY_RAW",
        "IXTABLE_CLOUD_PUBLIC_KEY",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    if std::env::var("IXTABLE_RELEASE").as_deref() != Ok("1") {
        return;
    }
    println!("cargo:rerun-if-changed=../scripts/release/dev-cloud-keys.json");
    let read = |path: &str| {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("release build: {path}: {e}"))
    };
    let raw = std::env::var("IXTABLE_CLOUD_PUBLIC_KEY_RAW").ok();
    let spki = std::env::var("IXTABLE_CLOUD_PUBLIC_KEY").ok();
    let problems = release_keys::release_key_problems(&release_keys::ReleaseKeys {
        cloud_raw: raw.as_deref(),
        cloud_spki: spki.as_deref(),
        dev_cloud_keys_json: &read("../scripts/release/dev-cloud-keys.json"),
    });
    if !problems.is_empty() {
        panic!(
            "IXTABLE_RELEASE=1 build refused: {} (docs/decisions/desktop-updates.md)",
            problems.join("; ")
        );
    }
}

fn main() {
    check_release_keys();
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
