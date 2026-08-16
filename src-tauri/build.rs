fn main() {
    if std::env::var_os("CARGO_FEATURE_TEST_BRIDGE").is_some() {
        napi_build::setup();
    }
    tauri_build::build()
}
