//! Desktop notifications for the portal's alerts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Manager};

use crate::alerts::Alert;

/// The notification currently shown for each chat: a newer alert replaces it.
static SHOWN: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(Mutex::default);

fn icon(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().app_cache_dir().ok()?.join("nako.png");
    if !path.is_file() {
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, include_bytes!("../icons/128x128.png")).ok()?;
    }
    Some(path)
}

fn base(app: &AppHandle, title: &str, body: &str) -> notify_rust::Notification {
    let mut notification = notify_rust::Notification::new();
    notification.appname("Nako").summary(title).body(body);
    if let Some(icon) = icon(app) {
        notification.icon(&icon.to_string_lossy());
    }
    notification
}

pub fn show(app: &AppHandle, alert: Alert) {
    // Nothing to tell someone already looking at the app.
    if let Some(window) = app.get_webview_window(crate::MAIN) {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut notification = base(&app, &alert.title, &alert.body);
        if let Some(session) = &alert.session {
            if let Some(id) = SHOWN.lock().unwrap().get(session) {
                notification.id(*id);
            }
            notification.action("default", "Open");
        }
        let Ok(handle) = notification.show() else { return };
        let Some(session) = alert.session else { return };
        SHOWN.lock().unwrap().insert(session.clone(), handle.id());
        #[cfg(all(unix, not(target_os = "macos")))]
        handle.wait_for_action(|action| {
            if action == "default" {
                let opener = app.clone();
                let _ = app.run_on_main_thread(move || crate::open_chat(&opener, &session));
            }
        });
    });
}

pub fn saved(app: &AppHandle, path: &Path) {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let notification = base(app, &format!("Saved {name}"), "In your Downloads folder");
    std::thread::spawn(move || {
        let _ = notification.show();
    });
}
