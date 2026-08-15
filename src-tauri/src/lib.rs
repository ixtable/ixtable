#[tauri_test::setup]
pub struct App;

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({"name": "ixtable", "runtime": "tauri"})
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running the ixtable application");
}
