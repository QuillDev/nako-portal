//! Self-updates from the release the portal publishes (`/api/desktop/release`), checked with
//! Tauri's updater, which verifies the download against the key built into the app. The update
//! downloads in the background and installs once nobody is using the window.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::origin::ServerOrigin;

static GENERATION: AtomicU64 = AtomicU64::new(0);
/// A verified download waiting for the window to lose focus.
static PENDING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

/// Whether this install replaces itself. The AppImage and the Windows installer's app do; the
/// .deb and the Homebrew app update through their package manager.
fn self_updates() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        cfg!(windows)
    }
}

/// Checks shortly after the portal opens, then every six hours (ten minutes after a failed
/// check, e.g. while signed out), until the portal changes.
pub fn watch(app: AppHandle, origin: ServerOrigin) {
    if !self_updates() {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        while GENERATION.load(Ordering::SeqCst) == generation && PENDING.lock().unwrap().is_none() {
            let wait = match check(&app, &origin).await {
                Ok(()) => 6 * 3600,
                Err(error) => {
                    eprintln!("nako: no update: {error}");
                    600
                }
            };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

async fn check(app: &AppHandle, origin: &ServerOrigin) -> Result<(), Box<dyn std::error::Error>> {
    let cookie = crate::cookie_header(app, origin).ok_or("not signed in")?;
    let updater = app.updater_builder().endpoints(vec![origin.page("/api/desktop/release")])?.header("Cookie", cookie)?.build()?;
    if let Some(update) = updater.check().await? {
        let bytes = update.download(|_, _| {}, || {}).await?;
        *PENDING.lock().unwrap() = Some((update, bytes));
        let handle = app.clone();
        app.run_on_main_thread(move || {
            announce(&handle);
            install_if_idle(&handle);
        })?;
    }
    Ok(())
}

/// Tells the portal page an update is ready, so it can offer a restart. Runs again on every
/// portal page load, since a reload forgets it.
pub fn announce(app: &AppHandle) {
    let Some(version) = PENDING.lock().unwrap().as_ref().map(|(update, _)| update.version.clone()) else { return };
    if let Some(window) = app.get_webview_window(crate::MAIN) {
        let _ = window.eval(announcement(&version));
    }
}

fn announcement(version: &str) -> String {
    let detail = serde_json::json!({ "version": version });
    format!("window.nakoUpdate = {detail}; window.dispatchEvent(new Event(\"nako-update\"))")
}

/// Installs a downloaded update and restarts into it, but never under someone using the window.
pub fn install_if_idle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(crate::MAIN) else { return };
    if window.is_focused().unwrap_or(false) {
        return;
    }
    install(app, !window.is_visible().unwrap_or(true));
}

/// The portal's update button: install now, focused or not, and come back with the window open.
pub fn install_now(app: &AppHandle) {
    install(app, false);
}

fn install(app: &AppHandle, hidden: bool) {
    let Some((update, bytes)) = PENDING.lock().unwrap().take() else { return };
    // On Windows this runs the installer passively; it closes the app and starts the new version.
    if let Err(error) = update.install(&bytes) {
        eprintln!("nako: update failed: {error}");
        return;
    }
    relaunch(app, hidden);
}

#[cfg(target_os = "linux")]
fn relaunch(app: &AppHandle, hidden: bool) {
    let Some(image) = std::env::var_os("APPIMAGE") else { return };
    // Start the new copy after this one has quit, so single-instance doesn't hand it back to us.
    let mut relaunch = std::process::Command::new("sh");
    relaunch.arg("-c").arg("sleep 1; exec \"$0\" \"$@\"").arg(image);
    if hidden {
        relaunch.arg("--hidden");
    }
    if relaunch.spawn().is_ok() {
        app.exit(0);
    }
}

#[cfg(not(target_os = "linux"))]
fn relaunch(app: &AppHandle, _hidden: bool) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::announcement;

    #[test]
    fn announcement_hands_the_page_the_version_as_data() {
        let script = announcement("1.2.3\"; alert(1); \"");
        assert_eq!(
            script,
            r#"window.nakoUpdate = {"version":"1.2.3\"; alert(1); \""}; window.dispatchEvent(new Event("nako-update"))"#
        );
    }
}
