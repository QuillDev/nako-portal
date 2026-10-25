use serde::{Deserialize, Serialize};
use url::Url;

/// The one portal this install talks to, normalized to `scheme://host[:port]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ServerOrigin(String);

impl ServerOrigin {
    /// Accepts `portal.example.com`, `https://portal.example.com/` or `http://10.0.0.5:8797`; None otherwise.
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return None;
        }
        let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
        let url = Url::parse(&with_scheme).ok()?;
        let bare = url.path() == "/" && url.query().is_none() && url.fragment().is_none() && url.username().is_empty() && url.password().is_none();
        if bare { origin_of(&url).map(ServerOrigin) } else { None }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn url(&self) -> Url {
        Url::parse(&format!("{}/", self.0)).expect("a parsed origin is a URL")
    }

    pub fn page(&self, path: &str) -> Url {
        self.url().join(path).expect("a path on the portal")
    }

    /// Only the portal itself stays in the app; every other link opens in the browser.
    pub fn opens_in_app(&self, link: &Url) -> bool {
        origin_of(link).as_deref() == Some(self.0.as_str())
    }

    /// The portal page for a chat a notification points at; None when the id isn't a session id.
    pub fn chat_page(&self, session: &str) -> Option<Url> {
        is_session_id(session).then(|| self.page(&format!("/#/c/{session}")))
    }

    /// The live-event socket alerts arrive on.
    pub fn socket_url(&self) -> String {
        format!("{}/ws", self.0.replacen("http", "ws", 1))
    }
}

pub fn is_session_id(session: &str) -> bool {
    (1..=120).contains(&session.len()) && session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn origin_of(url: &Url) -> Option<String> {
    let scheme = url.scheme();
    let host = url.host_str().filter(|h| !h.is_empty())?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    // `Url` already drops a default port and lowercases the host.
    Some(match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

impl TryFrom<String> for ServerOrigin {
    type Error = String;
    fn try_from(value: String) -> Result<Self, String> {
        ServerOrigin::parse(&value).ok_or_else(|| format!("not a portal address: {value}"))
    }
}

impl From<ServerOrigin> for String {
    fn from(origin: ServerOrigin) -> String {
        origin.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(input: &str) -> Option<String> {
        ServerOrigin::parse(input).map(|o| o.as_str().to_string())
    }

    #[test]
    fn addresses_normalize_to_a_bare_origin() {
        assert_eq!(origin("portal.example.com").as_deref(), Some("https://portal.example.com"));
        assert_eq!(origin("  HTTPS://Portal.Example.com/ ").as_deref(), Some("https://portal.example.com"));
        assert_eq!(origin("https://portal.example.com:443").as_deref(), Some("https://portal.example.com"));
        assert_eq!(origin("http://10.0.0.5:8797").as_deref(), Some("http://10.0.0.5:8797"));
    }

    #[test]
    fn anything_but_a_bare_http_origin_is_refused() {
        for input in ["", "https://portal.example.com/chat", "https://me:pw@portal.example.com", "https://portal.example.com/?a=1", "https://portal.example.com/#x", "ftp://portal.example.com", "file:///etc/passwd", "javascript:alert(1)"] {
            assert_eq!(origin(input), None, "{input}");
        }
    }

    #[test]
    fn only_the_portal_itself_stays_in_the_app() {
        let portal = ServerOrigin::parse("https://portal.example.com").unwrap();
        let stays = |link: &str| portal.opens_in_app(&Url::parse(link).unwrap());
        assert!(stays("https://portal.example.com/#/c/abc"));
        assert!(stays("https://PORTAL.example.com:443/api/file?x=1"));
        assert!(!stays("http://portal.example.com/"));
        assert!(!stays("https://portal.example.com.evil.example/"));
        assert!(!stays("https://github.com/QuillDev"));
        assert!(!stays("mailto:someone@example.com"));
    }

    #[test]
    fn notifications_open_their_chat_and_nothing_else() {
        let portal = ServerOrigin::parse("http://localhost:8851").unwrap();
        assert_eq!(portal.chat_page("20261024_090000_aaaaaa").unwrap().as_str(), "http://localhost:8851/#/c/20261024_090000_aaaaaa");
        assert_eq!(portal.chat_page("../settings"), None);
        assert_eq!(portal.chat_page(""), None);
        assert_eq!(portal.socket_url(), "ws://localhost:8851/ws");
        assert_eq!(ServerOrigin::parse("portal.example.com").unwrap().socket_url(), "wss://portal.example.com/ws");
    }
}
