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
    link_prebuilt_duckdb();
    tauri_build::build()
}

// The app links the prebuilt shared libduckdb (DUCKDB_LIB_DIR) and finds it at run time:
// - Linux: deb, rpm and AppImage install resources in ../lib/ixtable next to bin/, and dev
//   builds and the test bridge use the absolute download directory.
// - macOS: the bundle ships it in Contents/Frameworks (tauri.macos.conf.json).
// - Windows: the DLL sits next to the exe, so it is copied into target/<profile> for dev
//   builds and the test bridge (node loads the bridge with its own directory searched).
fn link_prebuilt_duckdb() {
    println!("cargo:rerun-if-env-changed=DUCKDB_LIB_DIR");
    let Some(dir) = std::env::var_os("DUCKDB_LIB_DIR").map(std::path::PathBuf::from) else {
        return;
    };
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => {
            // WebKitGTK references sqlite3_*, so the linker exports rusqlite's bundled SQLite.
            // sqlite_scanner carries its own SQLite and crashes on close when part of it binds
            // to ours, so hide archive symbols. Not in the test bridge: node needs its
            // napi_register_module_v1, which comes from an archive (rlib).
            if std::env::var_os("CARGO_FEATURE_TEST_BRIDGE").is_none() {
                println!("cargo:rustc-link-arg=-Wl,--exclude-libs,ALL");
            }
            println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/ixtable");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
        Ok("macos") => {
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
        Ok("windows") => {
            let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
            // OUT_DIR is target/<profile>/build/<pkg>/out.
            let profile_dir = out.ancestors().nth(3).expect("cargo OUT_DIR layout");
            let dll = dir.join("duckdb.dll");
            println!("cargo:rerun-if-changed={}", dll.display());
            std::fs::copy(&dll, profile_dir.join("duckdb.dll")).expect("copy duckdb.dll");
        }
        _ => {}
    }
}
