mod magento;
mod magento_config;
mod magento_io;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Improve performance on Linux
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            magento::magento_list,
            magento::magento_save,
            magento::magento_delete,
            magento::magento_reorder,
            magento::magento_check,
            magento::module_list,
            magento::module_command,
            magento::module_apply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
