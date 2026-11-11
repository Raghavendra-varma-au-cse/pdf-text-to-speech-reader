use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Allow only the bundled app (or the Next dev server) to load in the main
/// webview. Anything else is handed to the system browser and the in-app
/// navigation is cancelled, so a stray link can never replace the reader.
fn navigation_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("readaloud-navigation")
        .on_navigation(|webview, url| {
            let scheme = url.scheme();
            let host = url.host_str().unwrap_or_default();

            let internal = if cfg!(dev) {
                (scheme == "http" && matches!(host, "localhost" | "127.0.0.1"))
                    || (scheme == "tauri" && host == "localhost")
            } else {
                (scheme == "tauri" && host == "localhost")
                    || (cfg!(windows) && scheme == "http" && host == "tauri.localhost")
            };

            if internal || url.as_str() == "about:blank" {
                return true;
            }

            let external = (matches!(scheme, "http" | "https") && !host.is_empty())
                || matches!(scheme, "mailto" | "tel");
            if external {
                let _ = webview
                    .app_handle()
                    .opener()
                    .open_url(url.as_str(), None::<&str>);
            }

            false
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_plugin())
        .run(tauri::generate_context!())
        .expect("error while running ReadAloud");
}
