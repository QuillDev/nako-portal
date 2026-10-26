//! Self-updates from the release the portal publishes (`/api/desktop/release`), checked with
//! Tauri's updater, which verifies the download against the key built into the app. The update
//! downloads in the background and installs once nobody is using the window.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::origin::ServerOrigin;

static GENERATION: AtomicU64 = AtomicU64::new(0);
/// A verified download waiting for the window to lose focus.
static PENDING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
/// When the last check started, and whether one is running now.
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
static CHECKING: AtomicBool = AtomicBool::new(false);

/// Coming back to the app checks again once this long has passed since the last check, so a
/// window that has sat in the tray for hours finds a new release without waiting out the timer.
/// Debug builds take `NAKO_RECHECK_SECS`, so a local test needn't wait ten minutes.
fn recheck_after() -> Duration {
    let secs = cfg!(debug_assertions).then(|| std::env::var("NAKO_RECHECK_SECS").ok()?.parse().ok()).flatten();
    Duration::from_secs(secs.unwrap_or(10 * 60))
}

fn due(last: Option<Instant>, now: Instant, after: Duration) -> bool {
    last.is_none_or(|last| now.duration_since(last) >= after)
}

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
            let wait = if run_check(&app, &origin).await { 6 * 3600 } else { 600 };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

/// Checks for a release now, unless another check is running; true when the check got an answer.
async fn run_check(app: &AppHandle, origin: &ServerOrigin) -> bool {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return true;
    }
    *LAST_CHECK.lock().unwrap() = Some(Instant::now());
    let result = check(app, origin).await;
    CHECKING.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => true,
        Err(error) => {
            eprintln!("nako: no update: {error}");
            false
        }
    }
}

/// The window came back (focused, reopened from the tray, the portal reloaded): check for a
/// release if the last check was a while ago and nothing is waiting to install.
pub fn check_if_due(app: &AppHandle) {
    if !self_updates() || PENDING.lock().unwrap().is_some() || !due(*LAST_CHECK.lock().unwrap(), Instant::now(), recheck_after()) {
        return;
    }
    let Some(origin) = app.state::<crate::Shell>().origin() else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_check(&app, &origin).await;
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
    if let Some(portal) = app.get_webview(crate::MAIN) {
        let _ = portal.eval(announcement(&version));
    }
}

fn announcement(version: &str) -> String {
    let detail = serde_json::json!({ "version": version });
    format!("window.nakoUpdate = {detail}; window.dispatchEvent(new Event(\"nako-update\"))")
}

/// Installs a downloaded update and restarts into it, but never under someone using the window.
pub fn install_if_idle(app: &AppHandle) {
    let Some(window) = crate::window(app) else { return };
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
    use std::time::{Duration, Instant};

    use super::{announcement, due};

    #[test]
    fn coming_back_checks_again_only_after_a_while() {
        let (now, after) = (Instant::now(), Duration::from_secs(10 * 60));
        assert!(due(None, now, after), "never checked");
        assert!(!due(Some(now - Duration::from_secs(60)), now, after), "checked a minute ago");
        assert!(due(Some(now - Duration::from_secs(10 * 60)), now, after), "ten minutes ago");
        assert!(due(Some(now - Duration::from_secs(6 * 3600)), now, after), "hours in the tray");
    }

    #[test]
    fn announcement_hands_the_page_the_version_as_data() {
        let script = announcement("1.2.3\"; alert(1); \"");
        assert_eq!(
            script,
            r#"window.nakoUpdate = {"version":"1.2.3\"; alert(1); \""}; window.dispatchEvent(new Event("nako-update"))"#
        );
    }
}
