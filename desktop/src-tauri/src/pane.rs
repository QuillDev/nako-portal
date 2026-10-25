//! The in-app browser: links from the portal open in a pane on the right of the window, a toolbar
//! (the app's own `browser.html`) over the page. The portal keeps the rest of the window.
//!
//! Windows and macOS place the three webviews with bounds. Linux packs webviews into GTK boxes
//! (bounds do nothing there), so the pane's toolbar and page go in a column beside the portal.

use std::sync::Mutex;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl};

use crate::{browser, Shell, MAIN};

pub const BAR: &str = "pane-bar";
pub const PAGE: &str = "pane";
const BAR_HEIGHT: f64 = 40.0;

/// Below this window width the pane takes the whole window instead of sharing it.
const SIDE_BY_SIDE: f64 = 760.0;

#[derive(Default)]
pub struct Pane {
    open: Mutex<bool>,
    /// Only one pane gets built, even when two links are clicked at once.
    building: Mutex<()>,
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

/// Opens `url` in the pane, building it on first use. Safe to call from any thread except while
/// holding the main thread (navigation handlers run there, so they hand off to `open_later`).
pub fn open(app: &AppHandle, url: Url) {
    let shell = app.state::<Shell>();
    let _building = shell.pane.building.lock().unwrap();
    if let Some(page) = app.get_webview(PAGE) {
        let _ = page.navigate(url);
    } else if let Err(error) = build(app, url) {
        eprintln!("nako: no in-app browser: {error}");
        return;
    }
    *shell.pane.open.lock().unwrap() = true;
    show_parts(app, true);
    layout(app);
    tell_portal(app);
}

pub fn open_later(app: &AppHandle, url: Url) {
    let app = app.clone();
    std::thread::spawn(move || open(&app, url));
}

pub fn close(app: &AppHandle) {
    *app.state::<Shell>().pane.open.lock().unwrap() = false;
    if let Some(page) = app.get_webview(PAGE) {
        let _ = page.navigate(Url::parse("about:blank").unwrap());
    }
    show_parts(app, false);
    layout(app);
    tell_portal(app);
    if let Some(portal) = app.get_webview(MAIN) {
        let _ = portal.set_focus();
    }
}

pub fn is_open(app: &AppHandle) -> bool {
    *app.state::<Shell>().pane.open.lock().unwrap()
}

fn build(app: &AppHandle, url: Url) -> tauri::Result<()> {
    let window = app.get_window(MAIN).ok_or(tauri::Error::WindowNotFound)?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    let (_, x, width) = split(size.width, true);

    let bar = WebviewBuilder::new(BAR, WebviewUrl::App("browser.html".into()));
    #[cfg(not(target_os = "macos"))]
    let bar = bar.initialization_script(crate::WINDOW_CONTROLS);
    window.add_child(bar, LogicalPosition::new(x, 0.0), LogicalSize::new(width, BAR_HEIGHT))?;

    let (navigating, opening) = (app.clone(), app.clone());
    let page = WebviewBuilder::new(PAGE, WebviewUrl::External(url))
        .on_navigation(move |url| stays_in_pane(&navigating, url))
        .on_new_window(move |url, _| {
            if stays_in_pane(&opening, &url) {
                if let Some(page) = opening.get_webview(PAGE) {
                    let _ = page.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|page, payload| {
            if payload.event() == PageLoadEvent::Finished {
                report(&page, None);
            }
        })
        .on_document_title_changed(|page, title| report(&page, Some(title)))
        .on_download(crate::download);
    window.add_child(page, LogicalPosition::new(x, BAR_HEIGHT), LogicalSize::new(width, (size.height - BAR_HEIGHT).max(0.0)))?;

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

/// Shows the toolbar the page's address and title.
fn report(page: &Webview, title: Option<String>) {
    let Some(bar) = page.app_handle().get_webview(BAR) else { return };
    let Ok(url) = page.url() else { return };
    if url.scheme() == "about" {
        return;
    }
    let _ = bar.eval(status_script(url.as_str(), title.as_deref()));
}

fn status_script(url: &str, title: Option<&str>) -> String {
    let detail = serde_json::json!({ "url": url, "title": title });
    format!("window.nakoPane && window.nakoPane({detail})")
}

/// The toolbar's buttons.
#[tauri::command]
pub fn pane(app: AppHandle, action: String) {
    let Some(page) = app.get_webview(PAGE) else { return };
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
                let _ = browser::open(url.as_str());
            }
        }
        "close" => close(&app),
        // The toolbar asks once it has loaded, in case the page finished first.
        "status" => report(&page, None),
        _ => {}
    }
}

/// While the pane is open its toolbar holds the window buttons, so the portal hides its own
/// (they would sit in the middle of the window). Portals older than this ignore it.
pub fn tell_portal(app: &AppHandle) {
    #[cfg(not(target_os = "macos"))]
    if let Some(portal) = app.get_webview(MAIN) {
        let _ = portal.eval(portal_controls_script(!is_open(app)));
    }
    #[cfg(target_os = "macos")]
    let _ = app;
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn portal_controls_script(controls: bool) -> String {
    format!("if (window.nakoWindow) {{ window.nakoWindow.controls = {controls}; window.dispatchEvent(new Event(\"nako-window\")) }}")
}

fn show_parts(app: &AppHandle, visible: bool) {
    for label in [BAR, PAGE] {
        if let Some(part) = app.get_webview(label) {
            let _ = if visible { part.show() } else { part.hide() };
        }
    }
}

/// Puts the portal and the pane where `split` says, for the window's current size.
pub fn layout(app: &AppHandle) {
    let Some(window) = app.get_window(MAIN) else { return };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    let open = is_open(app) && app.get_webview(PAGE).is_some();
    let (portal_width, x, width) = split(size.width, open);

    #[cfg(target_os = "linux")]
    {
        let _ = (x, portal_width);
        linux::layout(app, open, width, size.width < SIDE_BY_SIDE);
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
        if open {
            place(BAR, x, 0.0, width, BAR_HEIGHT);
            place(PAGE, x, BAR_HEIGHT, width, size.height - BAR_HEIGHT);
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    //! GTK packs every webview into the window's box. The pane's toolbar and page move into a
    //! column of their own; the box turns horizontal so the column sits beside the portal.

    use gtk::prelude::*;
    use tauri::{AppHandle, Manager};

    use super::{BAR, BAR_HEIGHT, PAGE};
    use crate::MAIN;

    const COLUMN: &str = "nako-pane";

    pub fn name_parts(app: &AppHandle) {
        for label in [MAIN, BAR, PAGE] {
            if let Some(view) = app.get_webview(label) {
                let _ = view.with_webview(move |platform| platform.inner().set_widget_name(label));
            }
        }
    }

    fn named(container: &gtk::Box, name: &str) -> Option<gtk::Widget> {
        container.children().into_iter().find(|child| child.widget_name() == name)
    }

    pub fn layout(app: &AppHandle, open: bool, width: f64, narrow: bool) {
        let Some(window) = app.get_window(MAIN) else { return };
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(root) = target.default_vbox() else { return };
            let column = match named(&root, COLUMN).and_then(|w| w.downcast::<gtk::Box>().ok()) {
                Some(column) => column,
                None => {
                    let (Some(bar), Some(page)) = (named(&root, BAR), named(&root, PAGE)) else { return };
                    root.set_orientation(gtk::Orientation::Horizontal);
                    let column = gtk::Box::new(gtk::Orientation::Vertical, 0);
                    column.set_widget_name(COLUMN);
                    root.remove(&bar);
                    root.remove(&page);
                    bar.set_size_request(-1, BAR_HEIGHT as i32);
                    column.pack_start(&bar, false, false, 0);
                    column.pack_start(&page, true, true, 0);
                    root.pack_start(&column, false, false, 0);
                    column
                }
            };
            let portal = named(&root, MAIN);
            if open {
                column.set_size_request(if narrow { -1 } else { width as i32 }, -1);
                root.set_child_packing(&column, narrow, true, 0, gtk::PackType::Start);
                column.show_all();
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
    fn the_toolbar_gets_the_address_as_data() {
        let script = status_script("https://example.com/\"); alert(1); (\"", Some("</script>"));
        assert!(script.starts_with("window.nakoPane && window.nakoPane({"));
        assert!(script.contains(r#""url":"https://example.com/\"); alert(1); (\"""#), "{script}");
    }

    #[test]
    fn the_portal_is_told_to_hide_or_show_its_window_buttons() {
        assert!(portal_controls_script(false).contains("controls = false"));
        assert!(portal_controls_script(true).contains("controls = true"));
    }
}
