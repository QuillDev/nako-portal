//! The in-app browser: links from the portal open in a pane on the right of the window, a toolbar
//! (the app's own `browser.html`) over the page. The portal keeps the rest of the window.
//!
//! Every chat has a browser of its own, with tabs (`tabs.rs`). Each tab is a webview; only the
//! one on screen is shown, the rest are hidden and paused, and chats left a while ago are unloaded.
//!
//! Windows and macOS place the webviews with bounds. Linux packs webviews into GTK boxes
//! (bounds do nothing there), so the pane's toolbar and pages go in a column beside the portal.

use std::sync::Mutex;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl};

use crate::tabs::{Tab, Tabs, LIVE_CHATS};
use crate::{browser, Shell, MAIN};

pub const BAR: &str = "pane-bar";
/// Each tab's page is the webview `tab-<id>`.
const TAB: &str = "tab-";
const BAR_HEIGHT: f64 = 40.0;
/// The row of tabs under the toolbar, shown once a chat has more than one.
const STRIP_HEIGHT: f64 = 32.0;

/// Below this window width the pane takes the whole window instead of sharing it.
const SIDE_BY_SIDE: f64 = 760.0;

#[derive(Default)]
pub struct Pane {
    tabs: Mutex<Tabs>,
    /// One `sync` at a time, so two clicks don't build the same tab twice.
    applying: Mutex<()>,
    /// The tab last put on screen.
    visible: Mutex<Option<u64>>,
    search: Mutex<Engine>,
}

/// What the address bar searches with, picked in the portal's Settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Engine {
    #[default]
    Google,
    DuckDuckGo,
    Bing,
    Brave,
}

impl Engine {
    fn named(name: &str) -> Option<Self> {
        Some(match name {
            "google" => Self::Google,
            "duckduckgo" => Self::DuckDuckGo,
            "bing" => Self::Bing,
            "brave" => Self::Brave,
            _ => return None,
        })
    }

    fn base(self) -> &'static str {
        match self {
            Self::Google => "https://www.google.com/search",
            Self::DuckDuckGo => "https://duckduckgo.com/",
            Self::Bing => "https://www.bing.com/search",
            Self::Brave => "https://search.brave.com/search",
        }
    }
}

/// What the address bar's text means: an address (a scheme is optional) or a search with `engine`.
pub fn address_or_search(text: &str, engine: Engine) -> Option<Url> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if !text.contains(char::is_whitespace) {
        if let Ok(url) = Url::parse(text) {
            if matches!(url.scheme(), "http" | "https") {
                return Some(url);
            }
        }
        // example.com, localhost:3000, 10.0.0.2/admin: no scheme, but clearly a place.
        let host = text.split(['/', '?', '#']).next().unwrap_or_default();
        let name = host.rsplit_once(':').filter(|(_, port)| port.parse::<u16>().is_ok()).map_or(host, |(name, _)| name);
        let looks_like_host = name == "localhost" || (name.contains('.') && !name.starts_with('.') && !name.ends_with('.'));
        if looks_like_host {
            if let Ok(url) = Url::parse(&format!("https://{text}")) {
                return Some(url);
            }
        }
    }
    Url::parse_with_params(engine.base(), [("q", text)]).ok()
}

/// Where each part goes for a window `width` wide: (portal width, pane x, pane width).
/// A narrow window gives the pane all of it and hides the portal.
pub fn split(width: f64, open: bool) -> (f64, f64, f64) {
    if !open {
        return (width, width, 0.0);
    }
    if width < SIDE_BY_SIDE {
        return (0.0, 0.0, width);
    }
    let pane = (width * 0.45).clamp(360.0, width - 380.0).round();
    (width - pane, width - pane, pane)
}

/// Opens a link clicked in the chat: a new tab in that chat's browser, or the tab showing it already.
/// Navigation handlers run on the main thread, which building a webview needs free, so this hands off.
pub fn open_later(app: &AppHandle, url: Url) {
    change_later(app, move |tabs| {
        tabs.open_link(url);
    });
}

/// Puts the browser on screen away, keeping its tabs.
pub fn close(app: &AppHandle) {
    change_later(app, Tabs::hide);
    if let Some(portal) = app.get_webview(MAIN) {
        let _ = portal.set_focus();
    }
}

/// Changes the tabs, then makes the webviews match, off the calling thread.
fn change_later(app: &AppHandle, change: impl FnOnce(&mut Tabs) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || {
        change(&mut app.state::<Shell>().pane.tabs.lock().unwrap());
        sync(&app);
    });
}

/// Builds, shows, hides and drops webviews to match the tabs. Never call it on the main thread:
/// building a webview waits for it (and on Windows deadlocks there).
fn sync(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let pane = &shell.pane;
    let _one_at_a_time = pane.applying.lock().unwrap();
    let (gone, shown) = {
        let mut tabs = pane.tabs.lock().unwrap();
        (tabs.discard(LIVE_CHATS), tabs.shown().cloned())
    };
    for id in gone {
        if let Some(page) = app.get_webview(&label(id)) {
            let _ = page.close();
        }
    }
    if let Some(tab) = &shown {
        if app.get_webview(&label(tab.id)).is_none() {
            let url = tab.url.clone().unwrap_or_else(|| Url::parse("about:blank").unwrap());
            if let Err(error) = build(app, tab.id, url) {
                eprintln!("nako: no in-app browser: {error}");
                pane.tabs.lock().unwrap().close_tab(tab.id);
                return;
            }
        }
        if let Some(tab) = pane.tabs.lock().unwrap().tab(tab.id) {
            tab.live = true;
        }
    }
    let shown = shown.map(|t| t.id);
    // The page going out of sight stops: its videos pause, and on Windows the page is suspended
    // outright. Hidden pages on Linux and macOS are throttled by the engine itself.
    let before = std::mem::replace(&mut *pane.visible.lock().unwrap(), shown);
    if let Some(id) = before.filter(|id| Some(*id) != shown) {
        if let Some(page) = app.get_webview(&label(id)) {
            suspend(&page);
        }
    }
    for (name, view) in app.webviews() {
        let Some(id) = id_of(&name) else { continue };
        let _ = if Some(id) == shown { view.show() } else { view.hide() };
    }
    if let Some(bar) = app.get_webview(BAR) {
        let _ = if shown.is_some() { bar.show() } else { bar.hide() };
    }
    layout(app);
    report(app);
    tell_portal(app);
}

const PAUSE_MEDIA: &str = "document.querySelectorAll('video, audio').forEach(m => m.pause())";

fn suspend(page: &Webview) {
    let _ = page.eval(PAUSE_MEDIA);
    #[cfg(windows)]
    let _ = page.with_webview(|platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2TrySuspendCompletedHandler, ICoreWebView2_3};
        use windows_core::Interface;
        // Hidden first (sync does that), else WebView2 refuses. It resumes by itself when shown.
        if let Ok(core) = platform.controller().CoreWebView2() {
            if let Ok(core) = core.cast::<ICoreWebView2_3>() {
                let _ = core.TrySuspend(None::<&ICoreWebView2TrySuspendCompletedHandler>);
            }
        }
    });
}

fn label(id: u64) -> String {
    format!("{TAB}{id}")
}

fn id_of(label: &str) -> Option<u64> {
    label.strip_prefix(TAB)?.parse().ok()
}

/// Told by the portal whenever it shows another chat (or no chat): the browser beside it follows.
#[tauri::command]
pub async fn pane_chat(app: AppHandle, chat: Option<String>) {
    if app.state::<Shell>().pane.tabs.lock().unwrap().switch(chat) {
        sync(&app);
    }
}

/// The browser button in the portal's chat header.
#[tauri::command]
pub async fn pane_toggle(app: AppHandle) {
    app.state::<Shell>().pane.tabs.lock().unwrap().toggle();
    sync(&app);
    focus_address_if_blank(&app);
}

/// The portal hands over the search engine picked in its Settings on every load and change.
#[tauri::command]
pub fn pane_search(app: AppHandle, engine: String) {
    if let Some(engine) = Engine::named(&engine) {
        *app.state::<Shell>().pane.search.lock().unwrap() = engine;
    }
}

/// Runs in the portal: reports the chat on screen to `pane_chat` as it changes, and tells the
/// portal this app has a browser (with tabs, per chat) it can open from the header. Older apps
/// don't inject it, and older portals still use `#/c/<id>` routes, so it needs nothing from them.
pub const CHAT_WATCH: &str = r#"(() => {
  window.nakoBrowser = { search: true, toggle: true, open: false }
  let last
  const send = () => {
    const chat = (location.hash.match(/^#\/c\/([\w.-]+)/) || [])[1] || null
    if (chat === last || !window.__TAURI_INTERNALS__) return
    last = chat
    window.__TAURI_INTERNALS__.invoke("pane_chat", { chat }).catch(() => {})
  }
  addEventListener("hashchange", send)
  addEventListener("DOMContentLoaded", send)
})()"#;

pub fn is_open(app: &AppHandle) -> bool {
    app.state::<Shell>().pane.tabs.lock().unwrap().is_open()
}

/// The toolbar is taller while it shows a row of tabs.
fn bar_height(app: &AppHandle) -> f64 {
    if app.state::<Shell>().pane.tabs.lock().unwrap().strip().len() > 1 {
        BAR_HEIGHT + STRIP_HEIGHT
    } else {
        BAR_HEIGHT
    }
}

/// Builds the toolbar the first time, and a page for tab `id`.
fn build(app: &AppHandle, id: u64, url: Url) -> tauri::Result<()> {
    let window = app.get_window(MAIN).ok_or(tauri::Error::WindowNotFound)?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    let (_, x, width) = split(size.width, true);
    let height = bar_height(app);

    if app.get_webview(BAR).is_none() {
        let bar = WebviewBuilder::new(BAR, WebviewUrl::App("browser.html".into()));
        #[cfg(not(target_os = "macos"))]
        let bar = bar.initialization_script(crate::WINDOW_CONTROLS);
        window.add_child(bar, LogicalPosition::new(x, 0.0), LogicalSize::new(width, height))?;
    }

    let (navigating, opening) = (app.clone(), app.clone());
    let page = WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .on_navigation(move |url| stays_in_pane(&navigating, url))
        // Pages that open a window (target=_blank, window.open) get a new tab.
        .on_new_window(move |url, _| {
            if stays_in_pane(&opening, &url) {
                open_later(&opening, url);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|page, payload| {
            if payload.event() == PageLoadEvent::Finished {
                remember(&page, None);
            }
        })
        .on_document_title_changed(|page, title| remember(&page, Some(title)))
        .on_download(crate::download);
    window.add_child(page, LogicalPosition::new(x, height), LogicalSize::new(width, (size.height - height).max(0.0)))?;

    #[cfg(target_os = "linux")]
    linux::name_parts(app);
    Ok(())
}

/// Web pages browse on inside the pane; the portal's own pages go back to the portal, and
/// anything that isn't a web page (mailto:, app links) goes to the system.
fn stays_in_pane(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    if let Some(origin) = app.state::<Shell>().origin() {
        if origin.opens_in_app(url) {
            if let Some(portal) = app.get_webview(MAIN) {
                let _ = portal.navigate(url.clone());
            }
            return false;
        }
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        let _ = browser::open(url.as_str());
        return false;
    }
    true
}

/// Keeps a tab's address and title as its page moves on, for the tab strip and for loading it
/// again after it was unloaded.
fn remember(page: &Webview, title: Option<String>) {
    let app = page.app_handle();
    let Some(id) = id_of(page.label()) else { return };
    let Ok(url) = page.url() else { return };
    {
        let shell = app.state::<Shell>();
        let mut tabs = shell.pane.tabs.lock().unwrap();
        let Some(tab) = tabs.tab(id) else { return };
        // A new tab's blank page has no address worth keeping, and its title is just "about:blank".
        if url.scheme() == "about" {
            return;
        }
        if tab.url.as_ref() != Some(&url) && title.is_none() {
            tab.title = None;
        }
        tab.url = Some(url);
        if let Some(title) = title {
            tab.title = Some(title);
        }
    }
    report(app);
}

/// Shows the toolbar the tab on screen and this chat's tab strip.
fn report(app: &AppHandle) {
    let Some(bar) = app.get_webview(BAR) else { return };
    let shell = app.state::<Shell>();
    let script = {
        let tabs = shell.pane.tabs.lock().unwrap();
        status_script(tabs.shown(), tabs.strip())
    };
    let _ = bar.eval(script);
}

fn status_script(shown: Option<&Tab>, strip: &[Tab]) -> String {
    let tabs: Vec<_> = strip.iter().map(|t| serde_json::json!({ "id": t.id, "name": t.name() })).collect();
    let detail = serde_json::json!({
        "url": shown.and_then(|t| t.url.as_ref()).map(Url::as_str),
        "title": shown.and_then(|t| t.title.as_deref()),
        "active": shown.map(|t| t.id),
        "tabs": tabs,
    });
    format!("window.nakoPane && window.nakoPane({detail})")
}

fn shown_page(app: &AppHandle) -> Option<Webview> {
    let id = app.state::<Shell>().pane.tabs.lock().unwrap().shown()?.id;
    app.get_webview(&label(id))
}

/// A new tab opens on the address bar.
fn focus_address_if_blank(app: &AppHandle) {
    let blank = app.state::<Shell>().pane.tabs.lock().unwrap().shown().is_some_and(|t| t.url.is_none());
    if let (true, Some(bar)) = (blank, app.get_webview(BAR)) {
        let _ = bar.set_focus();
        let _ = bar.eval("window.nakoFocusAddress && window.nakoFocusAddress()");
    }
}

/// The toolbar's buttons and tabs.
#[tauri::command]
pub async fn pane(app: AppHandle, action: String, target: Option<String>) {
    let tab = || target.as_deref().and_then(|t| t.parse::<u64>().ok());
    let shell = app.state::<Shell>();
    let pane = &shell.pane;
    match action.as_str() {
        "new" => {
            pane.tabs.lock().unwrap().new_tab();
            sync(&app);
            focus_address_if_blank(&app);
            return;
        }
        "select" => {
            if let Some(id) = tab() {
                pane.tabs.lock().unwrap().select(id);
                sync(&app);
            }
            return;
        }
        "close-tab" => {
            if let Some(id) = tab() {
                if pane.tabs.lock().unwrap().close_tab(id) {
                    if let Some(page) = app.get_webview(&label(id)) {
                        let _ = page.close();
                    }
                    sync(&app);
                }
            }
            return;
        }
        "close" => {
            close(&app);
            return;
        }
        // The toolbar asks once it has loaded, in case the page finished first.
        "status" => {
            report(&app);
            return;
        }
        _ => {}
    }
    let Some(page) = shown_page(&app) else { return };
    match action.as_str() {
        "back" => {
            let _ = page.eval("history.back()");
        }
        "forward" => {
            let _ = page.eval("history.forward()");
        }
        "reload" => {
            let _ = page.reload();
        }
        "external" => {
            if let Ok(url) = page.url() {
                if url.scheme() != "about" {
                    let _ = browser::open(url.as_str());
                }
            }
        }
        "go" => {
            let engine = *pane.search.lock().unwrap();
            if let Some(url) = target.as_deref().and_then(|text| address_or_search(text, engine)) {
                let _ = page.navigate(url);
            }
        }
        _ => {}
    }
}

/// While the pane is open its toolbar holds the window buttons, so the portal hides its own
/// (they would sit in the middle of the window), and its browser button shows the browser is
/// open. Portals older than this ignore it.
pub fn tell_portal(app: &AppHandle) {
    if let Some(portal) = app.get_webview(MAIN) {
        let _ = portal.eval(portal_script(is_open(app)));
    }
}

fn portal_script(open: bool) -> String {
    let controls = if cfg!(target_os = "macos") {
        String::new()
    } else {
        format!("if (window.nakoWindow) {{ window.nakoWindow.controls = {}; window.dispatchEvent(new Event(\"nako-window\")) }}", !open)
    };
    format!("{controls}if (window.nakoBrowser) {{ window.nakoBrowser.open = {open}; window.dispatchEvent(new Event(\"nako-browser\")) }}")
}

/// Puts the portal and the pane where `split` says, for the window's current size.
pub fn layout(app: &AppHandle) {
    let Some(window) = app.get_window(MAIN) else { return };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    let shown = app.state::<Shell>().pane.tabs.lock().unwrap().shown().map(|t| label(t.id)).filter(|l| app.get_webview(l).is_some());
    let (portal_width, x, width) = split(size.width, shown.is_some());
    let bar = bar_height(app);

    #[cfg(target_os = "linux")]
    {
        let _ = (x, portal_width);
        linux::layout(app, shown, width, bar, size.width < SIDE_BY_SIDE);
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri::Rect;
        let place = |label: &str, x: f64, y: f64, w: f64, h: f64| {
            if let Some(view) = app.get_webview(label) {
                let _ = view.set_bounds(Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(0.0), h.max(0.0)).into() });
            }
        };
        place(MAIN, 0.0, 0.0, portal_width, size.height);
        if let Some(portal) = app.get_webview(MAIN) {
            let _ = if portal_width > 0.0 { portal.show() } else { portal.hide() };
        }
        if let Some(page) = shown {
            place(BAR, x, 0.0, width, bar);
            place(&page, x, bar, width, size.height - bar);
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    //! GTK packs every webview into the window's box. The pane's toolbar and pages move into a
    //! column of their own; the box turns horizontal so the column sits beside the portal.

    use gtk::prelude::*;
    use tauri::{AppHandle, Manager};

    use super::{BAR, TAB};
    use crate::MAIN;

    const COLUMN: &str = "nako-pane";
    const BAR_HOLDER: &str = "nako-pane-bar";

    pub fn name_parts(app: &AppHandle) {
        for (label, view) in app.webviews() {
            if label == MAIN || label == BAR || label.starts_with(TAB) {
                let _ = view.with_webview(move |platform| platform.inner().set_widget_name(&label));
            }
        }
    }

    fn named(container: &gtk::Box, name: &str) -> Option<gtk::Widget> {
        container.children().into_iter().find(|child| child.widget_name() == name)
    }

    /// `shown` is the label of the tab on screen, None when the browser is put away.
    pub fn layout(app: &AppHandle, shown: Option<String>, width: f64, bar_height: f64, narrow: bool) {
        let Some(window) = app.get_window(MAIN) else { return };
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(root) = target.default_vbox() else { return };
            let column = match named(&root, COLUMN).and_then(|w| w.downcast::<gtk::Box>().ok()) {
                Some(column) => column,
                None => {
                    if named(&root, BAR).is_none() {
                        return;
                    }
                    root.set_orientation(gtk::Orientation::Horizontal);
                    let column = gtk::Box::new(gtk::Orientation::Vertical, 0);
                    column.set_widget_name(COLUMN);
                    root.pack_start(&column, false, false, 0);
                    column
                }
            };
            // New webviews land in the window's box: the toolbar goes on top of the column, pages under it.
            for child in root.children() {
                let name = child.widget_name();
                if name == BAR {
                    // The toolbar changes height with its tab row, and a webview keeps asking for
                    // its tallest height so far; a scrolled window asks only for what it's set to.
                    root.remove(&child);
                    let holder = gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
                    holder.set_policy(gtk::PolicyType::External, gtk::PolicyType::External);
                    holder.set_widget_name(BAR_HOLDER);
                    holder.add(&child);
                    column.pack_start(&holder, false, false, 0);
                    column.reorder_child(&holder, 0);
                } else if name.starts_with(TAB) {
                    root.remove(&child);
                    column.pack_start(&child, true, true, 0);
                }
            }
            let open = shown.is_some();
            for child in column.children() {
                let name = child.widget_name();
                if name == BAR_HOLDER {
                    child.set_size_request(-1, bar_height as i32);
                    child.set_visible(open);
                    if let Some(bar) = child.downcast_ref::<gtk::Container>().and_then(|h| h.children().into_iter().next()) {
                        bar.set_visible(open);
                    }
                } else {
                    child.set_visible(shown.as_deref() == Some(name.as_str()));
                }
            }
            let portal = named(&root, MAIN);
            if open {
                column.set_size_request(if narrow { -1 } else { width as i32 }, -1);
                root.set_child_packing(&column, narrow, true, 0, gtk::PackType::Start);
                column.show();
                if let Some(portal) = &portal {
                    portal.set_visible(!narrow);
                }
            } else {
                column.hide();
                if let Some(portal) = &portal {
                    portal.set_visible(true);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_pane_leaves_the_portal_the_whole_window() {
        assert_eq!(split(1100.0, false), (1100.0, 1100.0, 0.0));
    }

    #[test]
    fn a_wide_window_shares_with_the_pane_and_keeps_the_portal_usable() {
        let (portal, x, pane) = split(1100.0, true);
        assert_eq!(portal + pane, 1100.0);
        assert_eq!(x, portal);
        assert!(pane >= 360.0 && portal >= 380.0, "{portal} / {pane}");
        let (portal, _, pane) = split(800.0, true);
        assert!(pane >= 360.0 && portal >= 380.0, "{portal} / {pane}");
    }

    #[test]
    fn a_narrow_window_gives_the_pane_all_of_it() {
        assert_eq!(split(500.0, true), (0.0, 0.0, 500.0));
    }

    #[test]
    fn the_toolbar_gets_the_address_and_tabs_as_data() {
        let tab = Tab { id: 7, url: Some(Url::parse("https://example.com/\"); alert(1); (\"").unwrap()), title: Some("</script>".into()), live: true };
        let script = status_script(Some(&tab), std::slice::from_ref(&tab));
        assert!(script.starts_with("window.nakoPane && window.nakoPane({"));
        let detail: serde_json::Value = serde_json::from_str(script.trim_start_matches("window.nakoPane && window.nakoPane(").trim_end_matches(')')).unwrap();
        assert_eq!(detail["url"], "https://example.com/%22);%20alert(1);%20(%22");
        assert_eq!(detail["active"], 7);
        assert_eq!(detail["tabs"][0]["name"], "</script>");
    }

    #[test]
    fn tab_pages_are_told_apart_from_the_other_webviews() {
        assert_eq!(id_of(&label(42)), Some(42));
        assert_eq!(id_of(BAR), None);
        assert_eq!(id_of(MAIN), None);
    }

    #[test]
    fn the_address_bar_takes_addresses_with_or_without_a_scheme() {
        let go = |text: &str| address_or_search(text, Engine::Google).map(|u| u.to_string());
        assert_eq!(go("https://github.com/QuillDev").as_deref(), Some("https://github.com/QuillDev"));
        assert_eq!(go("  example.com/a?b=1 ").as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(go("localhost:3000").as_deref(), Some("https://localhost:3000/"));
        assert_eq!(go("http://10.0.0.2:8080/x").as_deref(), Some("http://10.0.0.2:8080/x"));
        assert_eq!(go(""), None);
    }

    #[test]
    fn anything_else_in_the_address_bar_is_a_search() {
        let go = |text: &str| address_or_search(text, Engine::DuckDuckGo).unwrap();
        for text in ["rust tauri webview", "tauri", "what is 2.5 + 1", "file:///etc/passwd", "javascript:alert(1)"] {
            let url = go(text);
            assert_eq!(url.as_str().split('?').next(), Some("https://duckduckgo.com/"), "{text}");
            assert_eq!(url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).as_deref(), Some(text));
        }
    }

    #[test]
    fn searches_go_to_the_picked_engine_and_google_until_one_is_picked() {
        let search = |engine: Engine| address_or_search("nako app", engine).unwrap().to_string();
        assert_eq!(search(Engine::default()), "https://www.google.com/search?q=nako+app");
        assert_eq!(search(Engine::named("bing").unwrap()), "https://www.bing.com/search?q=nako+app");
        assert_eq!(search(Engine::named("brave").unwrap()), "https://search.brave.com/search?q=nako+app");
        assert_eq!(Engine::named("https://evil.example/?q="), None, "only the listed engines");
    }

    #[test]
    fn the_portal_is_told_whether_the_browser_is_open() {
        assert!(portal_script(true).contains("nakoBrowser.open = true"));
        assert!(portal_script(false).contains("nakoBrowser.open = false"));
        #[cfg(not(target_os = "macos"))]
        {
            assert!(portal_script(true).contains("controls = false"), "the toolbar has the window buttons");
            assert!(portal_script(false).contains("controls = true"));
        }
    }
}
