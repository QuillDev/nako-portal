//! Self-updates from the release the portal publishes (`/api/desktop/release`), checked with
//! Tauri's updater, which verifies the download against the key built into the app.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::origin::ServerOrigin;

static INSTALLED: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Checks shortly after the portal opens, then every six hours (ten minutes after a failed
/// check, e.g. while signed out), until the portal changes.
pub fn watch(app: AppHandle, origin: ServerOrigin) {
    // Only an AppImage can replace itself; packaged installs update through their package manager.
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        while GENERATION.load(Ordering::SeqCst) == generation && !INSTALLED.load(Ordering::SeqCst) {
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
        update.download_and_install(|_, _| {}, || {}).await?;
        INSTALLED.store(true, Ordering::SeqCst);
        let handle = app.clone();
        app.run_on_main_thread(move || restart_if_pending(&handle))?;
    }
    Ok(())
}

/// Restarts into the installed update, but never under someone using the window.
pub fn restart_if_pending(app: &AppHandle) {
    if !INSTALLED.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(crate::MAIN) else { return };
    if window.is_focused().unwrap_or(false) {
        return;
    }
    let hidden = !window.is_visible().unwrap_or(true);
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
