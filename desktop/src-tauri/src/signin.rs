//! Signing in through the browser. The webview can't use passkeys (WebKitGTK has no WebAuthn),
//! so the app opens the portal in the browser, which already has the passkey. The signed-in page
//! sends a one-time code back to a listener on 127.0.0.1, and the webview trades that code plus a
//! secret only this app knows (PKCE, RFC 8252) for its own login cookie.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::origin::ServerOrigin;

pub struct Handoff {
    /// Where the browser goes to approve this sign-in.
    pub browser_url: Url,
    origin: ServerOrigin,
    listener: TcpListener,
    state: String,
    verifier: String,
}

const SIGNED_IN: &str = "<!doctype html><meta charset=utf-8><title>Nako</title><body style=\"background:#0d0a11;color:#f3eaef;font:16px Inter,system-ui,sans-serif;display:grid;place-items:center;height:90vh\">Signed in. You can close this tab and go back to Nako.";

fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub async fn begin(origin: &ServerOrigin) -> std::io::Result<Handoff> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (state, verifier) = (random(), random());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("port", &port.to_string())
        .append_pair("state", &state)
        .append_pair("challenge", &challenge)
        .finish();
    let browser_url = origin.page(&format!("/#/desktop?{query}"));
    Ok(Handoff { browser_url, origin: origin.clone(), listener, state, verifier })
}

impl Handoff {
    /// Waits for the browser to come back with a code, then returns the page that signs the webview in.
    /// Requests that don't carry this sign-in's state are turned away and the wait goes on.
    pub async fn wait(self, timeout: Duration) -> Option<Url> {
        tokio::time::timeout(timeout, async {
            loop {
                let Ok((stream, _)) = self.listener.accept().await else { continue };
                if let Some(code) = self.answer(stream).await {
                    let mut url = self.origin.page("/api/desktop/session");
                    url.query_pairs_mut().append_pair("code", &code).append_pair("verifier", &self.verifier);
                    return url;
                }
            }
        })
        .await
        .ok()
    }

    async fn answer(&self, mut stream: TcpStream) -> Option<String> {
        let mut buffer = vec![0u8; 8192];
        let read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buffer)).await.ok()?.ok()?;
        let head = String::from_utf8_lossy(&buffer[..read]);
        let target = head.lines().next()?.strip_prefix("GET ")?.split(' ').next()?;
        let url = Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
        let pair = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        let code = (url.path() == "/callback" && pair("state").as_deref() == Some(self.state.as_str())).then(|| pair("code")).flatten();
        let (status, body) = match code {
            Some(_) => ("200 OK", SIGNED_IN),
            None => ("400 Bad Request", "This isn't a sign-in this app started."),
        };
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(response.as_bytes()).await;
        code.filter(|c| !c.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn browser(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn the_browser_hands_the_code_back_and_the_app_redeems_it_with_its_secret() {
        let portal = ServerOrigin::parse("https://portal.example.com").unwrap();
        let handoff = begin(&portal).await.unwrap();

        // What the browser is asked to approve: a loopback port, a state, and a challenge.
        let url = handoff.browser_url.clone();
        assert_eq!(url.origin().ascii_serialization(), "https://portal.example.com");
        let query = url.fragment().unwrap().strip_prefix("/desktop?").unwrap().to_string();
        let ask: std::collections::HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        let port: u16 = ask["port"].parse().unwrap();

        let waiting = tokio::spawn(handoff.wait(Duration::from_secs(10)));
        // Someone else's state (or no code) is turned away, and the app keeps waiting.
        assert!(browser(port, "/callback?code=stolen&state=wrong").await.starts_with("HTTP/1.1 400"));
        assert!(browser(port, &format!("/callback?state={}", ask["state"])).await.starts_with("HTTP/1.1 400"));
        assert!(browser(port, &format!("/callback?code=c0de&state={}", ask["state"])).await.starts_with("HTTP/1.1 200"));

        let finish = waiting.await.unwrap().expect("signed in");
        assert_eq!(finish.origin().ascii_serialization(), "https://portal.example.com");
        assert_eq!(finish.path(), "/api/desktop/session");
        let pairs: std::collections::HashMap<String, String> = finish.query_pairs().into_owned().collect();
        assert_eq!(pairs["code"], "c0de");
        // The secret proves this app started the sign-in: it hashes to the challenge the browser saw.
        assert_eq!(URL_SAFE_NO_PAD.encode(Sha256::digest(pairs["verifier"].as_bytes())), ask["challenge"]);
    }

    #[tokio::test]
    async fn an_abandoned_sign_in_gives_up() {
        let portal = ServerOrigin::parse("https://portal.example.com").unwrap();
        let handoff = begin(&portal).await.unwrap();
        assert_eq!(handoff.wait(Duration::from_millis(200)).await, None);
    }
}
