//! Opening links in the system browser. Inside an AppImage the app runs with the image's
//! library and GTK paths in its environment; a browser started with them can crash or load the
//! wrong libraries, so it gets the environment the user had before the AppImage started.

use std::ffi::OsString;

/// The environment for programs the app starts: entries pointing into the AppImage are dropped,
/// and path lists keep only their entries outside it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn clean_env(vars: impl IntoIterator<Item = (OsString, OsString)>, appdir: Option<&str>) -> Vec<(OsString, OsString)> {
    let Some(appdir) = appdir.filter(|a| !a.is_empty()) else { return vars.into_iter().collect() };
    vars.into_iter()
        .filter_map(|(key, value)| {
            // The AppImage's own markers and its forced theme.
            if matches!(key.to_str(), Some("APPDIR" | "APPIMAGE" | "ARGV0" | "OWD" | "GTK_THEME")) {
                return None;
            }
            let text = value.to_string_lossy();
            if !text.contains(appdir) {
                return Some((key, value));
            }
            let kept: Vec<&str> = text.split(':').filter(|part| !part.is_empty() && !part.starts_with(appdir)).collect();
            (!kept.is_empty() && text.contains(':')).then(|| (key, OsString::from(kept.join(":"))))
        })
        .collect()
}

/// The command a `$BROWSER` setting (`firefox`, `chrome --new-window %s`) runs for `url`.
/// Linux's openers already read it; on Windows and macOS the app does.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn browser_command(setting: &str, url: &str) -> Option<Vec<String>> {
    let mut parts: Vec<String> = setting.split_whitespace().map(str::to_string).collect();
    if parts.is_empty() {
        return None;
    }
    if parts.iter().any(|p| p.contains("%s")) {
        parts.iter_mut().for_each(|p| *p = p.replace("%s", url));
    } else {
        parts.push(url.to_string());
    }
    Some(parts)
}

pub fn open(url: &str) -> std::io::Result<()> {
    #[cfg(not(target_os = "linux"))]
    if let Some(command) = std::env::var("BROWSER").ok().and_then(|b| browser_command(&b, url)) {
        return std::process::Command::new(&command[0]).args(&command[1..]).spawn().map(drop);
    }
    #[cfg(target_os = "linux")]
    {
        let appdir = std::env::var("APPDIR").ok();
        let started = std::process::Command::new("xdg-open").arg(url).env_clear().envs(clean_env(std::env::vars_os(), appdir.as_deref())).spawn();
        if started.is_ok() {
            return Ok(());
        }
    }
    webbrowser::open(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn a_browser_started_from_the_appimage_gets_the_users_own_environment() {
        let app = "/tmp/.mount_nakoXYZ";
        let inside = env(&[
            ("HOME", "/home/someone"),
            ("DISPLAY", ":0"),
            ("PATH", "/tmp/.mount_nakoXYZ/usr/bin:/usr/local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_nakoXYZ/usr/lib/:/tmp/.mount_nakoXYZ/usr/lib64"),
            ("XDG_DATA_DIRS", "/tmp/.mount_nakoXYZ/usr/share/:/usr/local/share:/usr/share"),
            ("PYTHONHOME", "/tmp/.mount_nakoXYZ/usr/"),
            ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_nakoXYZ//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            ("GTK_THEME", "Adwaita:light"),
            ("APPDIR", app),
            ("APPIMAGE", "/home/someone/Applications/nako.AppImage"),
        ]);
        let mut cleaned: Vec<(String, String)> = clean_env(inside, Some(app)).into_iter().map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap())).collect();
        cleaned.sort();
        assert_eq!(
            cleaned,
            [
                ("DISPLAY".into(), ":0".into()),
                ("HOME".into(), "/home/someone".into()),
                ("PATH".into(), "/usr/local/bin:/usr/bin".into()),
                ("XDG_DATA_DIRS".into(), "/usr/local/share:/usr/share".into()),
            ]
        );
    }

    #[test]
    fn a_browser_setting_runs_with_the_link() {
        let url = "https://portal.example.com/#/desktop?port=1";
        assert_eq!(browser_command("firefox", url).unwrap(), ["firefox", url]);
        assert_eq!(browser_command("chrome --new-window %s", url).unwrap(), ["chrome", "--new-window", url]);
        assert_eq!(browser_command("  ", url), None);
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        let vars = env(&[("LD_LIBRARY_PATH", "/opt/lib"), ("GTK_THEME", "Adwaita:dark")]);
        assert_eq!(clean_env(vars.clone(), None), vars);
    }
}
