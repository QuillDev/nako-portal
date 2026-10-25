//! Nako Portal's desktop shell: the portal's own web app in a webview, plus the glue a browser
//! tab can't do (a server prompt, browser sign-in, notifications, self-updates).

pub mod alerts;
mod browser;
mod notify;
pub mod origin;
pub mod signin;
mod update;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::Notify;

use origin::ServerOrigin;

const MAIN: &str = "main";

#[derive(Default)]
struct Shell {
    origin: Mutex<Option<ServerOrigin>>,
    /// Rung on every portal page load: a sign-in may have just set the cookie the alert socket needs.
    wake: Arc<Notify>,
    listener: Mutex<Option<JoinHandle<()>>>,
    sign_in: Mutex<Option<JoinHandle<()>>>,
    /// Closing the window hides it to the tray (when there is one), so alerts keep coming.
    tray: AtomicBool,
}

impl Shell {
    fn origin(&self) -> Option<ServerOrigin> {
        self.origin.lock().unwrap().clone()
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    origin: Option<ServerOrigin>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

fn saved_origin(app: &AppHandle) -> Option<ServerOrigin> {
    let raw = std::fs::read(settings_path(app)?).ok()?;
    serde_json::from_slice::<Settings>(&raw).ok()?.origin
}

fn save_origin(app: &AppHandle, origin: &ServerOrigin) {
    let Some(path) = settings_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let settings = Settings { origin: Some(origin.clone()) };
    let _ = std::fs::write(path, serde_json::to_vec_pretty(&settings).unwrap());
}

/// The app's own connect page (server prompt, "can't reach").
fn local_page(query: &str) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(&format!("{base}{query}")).unwrap()
}

fn is_local(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") || url.scheme() == "about"
}

async fn reachable(origin: &ServerOrigin) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let response = client.get(origin.page("/api/me")).send().await.map_err(|error| {
        eprintln!("nako: {}: {error:?}", origin.as_str());
        format!("Can't reach {}", origin.as_str())
    })?;
    let me: serde_json::Value = response.json().await.map_err(|_| format!("{} isn't a Nako portal", origin.as_str()))?;
    match me.get("signed_in") {
        Some(_) => Ok(()),
        None => Err(format!("{} isn't a Nako portal", origin.as_str())),
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Start {
    Ask { origin: Option<String> },
    Open,
    Unreachable { origin: String, error: String },
}

/// The connect page asks what to show: the prompt, or (with a saved portal that answers) the portal itself.
#[tauri::command]
async fn start(app: AppHandle, change: bool) -> Start {
    let Some(origin) = saved_origin(&app) else { return Start::Ask { origin: None } };
    if change {
        return Start::Ask { origin: Some(origin.as_str().into()) };
    }
    match reachable(&origin).await {
        Ok(()) => {
            open_portal(&app, origin);
            Start::Open
        }
        Err(error) => Start::Unreachable { origin: origin.as_str().into(), error },
    }
}

#[tauri::command]
async fn connect(app: AppHandle, address: String) -> Result<(), String> {
    let origin = ServerOrigin::parse(&address).ok_or("Enter an address like https://portal.example.com")?;
    reachable(&origin).await?;
    save_origin(&app, &origin);
    open_portal(&app, origin);
    Ok(())
}

fn open_portal(app: &AppHandle, origin: ServerOrigin) {
    let shell = app.state::<Shell>();
    let changed = shell.origin.lock().unwrap().replace(origin.clone()).as_ref() != Some(&origin);
    if changed || shell.listener.lock().unwrap().is_none() {
        listen(app, origin.clone());
        update::watch(app.clone(), origin.clone());
    }
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.navigate(origin.url());
    }
}

pub(crate) fn cookie_header(app: &AppHandle, origin: &ServerOrigin) -> Option<String> {
    let window = app.get_webview_window(MAIN)?;
    let cookies = window.cookies_for_url(origin.url()).ok()?;
    let header = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
    (!header.is_empty()).then_some(header)
}

fn listen(app: &AppHandle, origin: ServerOrigin) {
    let shell = app.state::<Shell>();
    let (handle, wake) = (app.clone(), shell.wake.clone());
    let task = tauri::async_runtime::spawn(async move {
        let notifier = handle.clone();
        let target = origin.clone();
        alerts::listen(origin, move || cookie_header(&handle, &target), wake, move |alert| notify::show(&notifier, alert)).await
    });
    let old = shell.listener.lock().unwrap().replace(task);
    if let Some(old) = old {
        old.abort();
    }
}

fn sign_in(app: &AppHandle, origin: ServerOrigin) {
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let Ok(handoff) = signin::begin(&origin).await else { return };
        if let Err(error) = browser::open(handoff.browser_url.as_str()) {
            eprintln!("nako: couldn't open the browser: {error}");
            return;
        }
        if let Some(finish) = handoff.wait(Duration::from_secs(300)).await {
            if let Some(window) = handle.get_webview_window(MAIN) {
                let _ = window.navigate(finish);
                show(&window);
            }
        }
    });
    // A second click starts over; the earlier browser tab's code then has nowhere to go.
    let old = app.state::<Shell>().sign_in.lock().unwrap().replace(task);
    if let Some(old) = old {
        old.abort();
    }
}

/// Same-origin pages stay in the app; everything else opens in the browser.
fn navigation_allowed(app: &AppHandle, url: &Url) -> bool {
    if is_local(url) {
        return true;
    }
    let Some(origin) = app.state::<Shell>().origin() else { return false };
    if !origin.opens_in_app(url) {
        let _ = browser::open(url.as_str());
        return false;
    }
    // The sign-in page's button for the desktop app.
    if url.path() == "/desktop/sign-in" {
        sign_in(app, origin);
        return false;
    }
    true
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        show(&window);
    }
}

/// A clicked notification opens its chat, without reloading the page when it's already the portal.
pub(crate) fn open_chat(app: &AppHandle, session: &str) {
    let (Some(window), Some(origin)) = (app.get_webview_window(MAIN), app.state::<Shell>().origin()) else { return };
    let Some(page) = origin.chat_page(session) else { return };
    show(&window);
    let on_portal = window.url().map(|u| origin.opens_in_app(&u)).unwrap_or(false);
    if on_portal {
        let hash = serde_json::to_string(&format!("#/c/{session}")).unwrap();
        let _ = window.eval(format!("location.hash = {hash}"));
    } else {
        let _ = window.navigate(page);
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Nako", true, None::<&str>)?,
            &MenuItem::with_id(app, "server", "Change server", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("nako")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Nako")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "server" => {
                if let Some(window) = app.get_webview_window(MAIN) {
                    let _ = window.navigate(local_page("?change=1"));
                    show(&window);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main_window(app: &AppHandle, hidden: bool) -> tauri::Result<WebviewWindow> {
    let navigating = app.clone();
    let opening = app.clone();
    let version = app.package_info().version.to_string();
    // 1100x780, or less on a smaller screen.
    let (mut width, mut height) = (1100.0, 780.0);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let screen = monitor.work_area().size.to_logical::<f64>(monitor.scale_factor());
        (width, height) = (f64::min(width, screen.width * 0.92), f64::min(height, screen.height * 0.92));
    }
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()));
    // Tag the user agent so the portal offers browser sign-in instead of passkeys. WebKitGTK's own
    // agent is extended after creation (below); elsewhere the webview takes a whole agent.
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(&format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NakoDesktop/{version}"));
    #[cfg(windows)]
    let builder = builder.user_agent(&format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) NakoDesktop/{version}"));
    let window = builder
        .title("Nako")
        .inner_size(width, height)
        .center()
        .min_inner_size(380.0, 480.0)
        .visible(!hidden)
        .background_color(tauri::webview::Color(0x0d, 0x0a, 0x11, 0xff))
        .on_navigation(move |url| navigation_allowed(&navigating, url))
        .on_new_window(move |url, _| {
            if navigation_allowed(&opening, &url) {
                if let Some(window) = opening.get_webview_window(MAIN) {
                    let _ = window.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            let app = window.app_handle();
            let on_portal = app.state::<Shell>().origin().is_some_and(|o| o.opens_in_app(payload.url()));
            if payload.event() == PageLoadEvent::Finished && on_portal {
                app.state::<Shell>().wake.notify_one();
            }
        })
        .on_download(|webview, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    if let (Ok(dir), Some(name)) = (webview.app_handle().path().download_dir(), destination.file_name()) {
                        *destination = dir.join(name);
                    }
                }
                DownloadEvent::Finished { path: Some(path), success: true, .. } => notify::saved(webview.app_handle(), &path),
                DownloadEvent::Finished { .. } => {}
                _ => {}
            }
            true
        })
        .build()?;

    #[cfg(target_os = "linux")]
    window.with_webview(move |webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = webview.inner().settings() {
            let agent = settings.user_agent().map(|u| u.to_string()).unwrap_or_default();
            settings.set_user_agent(Some(&format!("{agent} NakoDesktop/{version}")));
        }
    })?;
    #[cfg(not(target_os = "linux"))]
    let _ = version;
    Ok(window)
}

pub fn run() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![start, connect])
        .setup(move |app| {
            let handle = app.handle();
            let tray_ok = match tray(handle) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("nako: no tray: {error}");
                    false
                }
            };
            app.state::<Shell>().tray.store(tray_ok, Ordering::Relaxed);
            main_window(handle, hidden && tray_ok)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<Shell>().tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let WindowEvent::Focused(false) = event {
                update::install_if_idle(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting Nako")
        .run(|app, event| {
            // Clicking the Dock icon brings back a window that was closed to the menu bar.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            let _ = (app, event);
        });
}
