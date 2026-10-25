//! Desktop notifications for the portal's alerts.

use std::path::Path;

use tauri::AppHandle;

use crate::alerts::Alert;

fn base(app: &AppHandle, title: &str, body: &str) -> notify_rust::Notification {
    let mut notification = notify_rust::Notification::new();
    notification.appname("Nako").summary(title).body(body);
    platform::prepare(app, &mut notification);
    notification
}

pub fn show(app: &AppHandle, alert: Alert) {
    // Nothing to tell someone already looking at the app.
    if let Some(window) = crate::window(app) {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut notification = base(&app, &alert.title, &alert.body);
        let Some(session) = alert.session else {
            platform::post(notification);
            return;
        };
        platform::replace(&mut notification, &session);
        // Clicking the notification opens its chat.
        let chat = session.clone();
        platform::post_and_wait(notification, &chat, move || {
            let opener = app.clone();
            let _ = app.run_on_main_thread(move || crate::open_chat(&opener, &session));
        });
    });
}

pub fn saved(app: &AppHandle, path: &Path) {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let notification = base(app, &format!("Saved {name}"), "In your Downloads folder");
    std::thread::spawn(move || platform::post(notification));
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    use notify_rust::Notification;
    use tauri::{AppHandle, Manager};

    /// The notification currently shown for each chat: a newer alert replaces it.
    static SHOWN: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(Mutex::default);

    pub fn prepare(app: &AppHandle, notification: &mut Notification) {
        let Some(dir) = app.path().app_cache_dir().ok() else { return };
        let path = dir.join("nako.png");
        if !path.is_file() && (std::fs::create_dir_all(&dir).is_err() || std::fs::write(&path, include_bytes!("../icons/128x128.png")).is_err()) {
            return;
        }
        notification.icon(&path.to_string_lossy());
    }

    pub fn replace(notification: &mut Notification, session: &str) {
        if let Some(id) = SHOWN.lock().unwrap().get(session) {
            notification.id(*id);
        }
        notification.action("default", "Open");
    }

    pub fn post(notification: Notification) {
        let _ = notification.show();
    }

    pub fn post_and_wait(notification: Notification, session: &str, open: impl FnOnce()) {
        let Ok(handle) = notification.show() else { return };
        SHOWN.lock().unwrap().insert(session.to_string(), handle.id());
        handle.wait_for_action(|action| {
            if action == "default" {
                open();
            }
        });
    }
}

#[cfg(windows)]
mod platform {
    use notify_rust::{Notification, NotificationResponse};
    use tauri::AppHandle;

    pub fn prepare(app: &AppHandle, notification: &mut Notification) {
        // The installer registers the Start menu shortcut under the bundle identifier, which
        // makes toasts show as Nako with its icon.
        notification.app_id(&app.config().identifier);
    }

    pub fn replace(_notification: &mut Notification, _session: &str) {}

    pub fn post(notification: Notification) {
        let _ = notification.show();
    }

    pub fn post_and_wait(notification: Notification, _session: &str, open: impl FnOnce()) {
        let handle = match notification.show() {
            Ok(handle) => handle,
            Err(error) => return eprintln!("nako: notification: {error}"),
        };
        let _ = handle.wait_for_response(|response: &NotificationResponse| {
            if matches!(response, NotificationResponse::Default) {
                open();
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Once;

    use notify_rust::Notification;
    use tauri::AppHandle;

    static APPLICATION: Once = Once::new();

    pub fn prepare(app: &AppHandle, _notification: &mut Notification) {
        // Post as this app, not as Terminal or Finder.
        let identifier = app.config().identifier.clone();
        APPLICATION.call_once(|| {
            let _ = notify_rust::set_application(&identifier);
        });
    }

    pub fn replace(_notification: &mut Notification, _session: &str) {}

    // The macOS backend posts when it's waited on.
    pub fn post(notification: Notification) {
        if let Ok(handle) = notification.show() {
            handle.wait_for_action(|_| {});
        }
    }

    pub fn post_and_wait(notification: Notification, _session: &str, open: impl FnOnce()) {
        let Ok(handle) = notification.show() else { return };
        handle.wait_for_action(|action| {
            if action == "default" {
                open();
            }
        });
    }
}
