//! One socket to the portal's live events, turned into desktop notifications.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error, Message};

use crate::origin::ServerOrigin;

/// One "turn finished / needs you / inbox" alert the portal pushes over its live socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub title: String,
    pub body: String,
    pub session: Option<String>,
}

/// The alert in a socket frame, or None for every other kind of frame (or junk).
pub fn parse_alert(frame: &str) -> Option<Alert> {
    let value: Value = serde_json::from_str(frame).ok()?;
    if value.get("kind")?.as_str()? != "alert" {
        return None;
    }
    let title = value.get("title")?.as_str()?;
    let body = value.get("body").and_then(Value::as_str).unwrap_or("");
    let session = value.get("session").and_then(Value::as_str).map(str::to_string);
    Some(Alert { title: title.chars().take(120).collect(), body: body.chars().take(400).collect(), session })
}

/// How long to wait before reconnect attempt `attempt` (0-based): 2, 4, 8 … seconds, capped at 5 minutes.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(300.min(2u64 << attempt.min(8)))
}

/// Listens until the task is dropped. Without a cookie, or once the portal refuses it (signed
/// out), it waits for `wake`, which the app rings whenever a portal page finishes loading.
pub async fn listen(origin: ServerOrigin, cookie: impl Fn() -> Option<String>, wake: Arc<Notify>, on_alert: impl Fn(Alert)) {
    let mut attempt = 0;
    loop {
        let Some(cookie) = cookie() else {
            wake.notified().await;
            continue;
        };
        let mut request = origin.socket_url().into_client_request().expect("the portal's socket URL");
        let headers = request.headers_mut();
        let (Ok(cookie), Ok(from)) = (HeaderValue::from_str(&cookie), HeaderValue::from_str(origin.as_str())) else {
            wake.notified().await;
            continue;
        };
        headers.insert("Cookie", cookie);
        headers.insert("Origin", from);
        match tokio_tungstenite::connect_async(request).await {
            Ok((mut socket, _)) => {
                attempt = 0;
                while let Some(Ok(message)) = socket.next().await {
                    if let Message::Text(text) = message {
                        if let Some(alert) = parse_alert(&text) {
                            on_alert(alert);
                        }
                    }
                }
            }
            Err(Error::Http(response)) if matches!(response.status().as_u16(), 401 | 403) => {
                // Signed out (cookie expired or passkey removed): wait for the next sign-in.
                wake.notified().await;
                continue;
            }
            Err(_) => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff(attempt)) => {}
            _ = wake.notified() => {}
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use std::sync::Mutex;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::StatusCode;

    #[test]
    fn alert_frames_become_notifications_and_everything_else_is_ignored() {
        let alert = parse_alert(r#"{"kind":"alert","title":"Fix the build","body":"done","session":"20261024_020202_bbbbbb"}"#);
        assert_eq!(alert, Some(Alert { title: "Fix the build".into(), body: "done".into(), session: Some("20261024_020202_bbbbbb".into()) }));
        assert_eq!(parse_alert(r#"{"kind":"alert","title":"Nako","body":"daily digest","session":null}"#).unwrap().session, None);
        assert_eq!(parse_alert(r#"{"kind":"status","session":"x","status":"done"}"#), None);
        assert_eq!(parse_alert(r#"{"kind":"event","type":"message.delta","payload":{"text":"secret"}}"#), None);
        assert_eq!(parse_alert(r#"{"kind":"alert"}"#), None);
        assert_eq!(parse_alert("not json"), None);
    }

    #[test]
    fn reconnects_back_off_to_five_minutes() {
        let seconds: Vec<u64> = (0..4).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(seconds, [2, 4, 8, 16]);
        assert_eq!(backoff(20).as_secs(), 300);
    }

    /// A portal socket that only lets in `portal=good` from its own origin, then sends a status frame and an alert.
    #[allow(clippy::result_large_err)] // tungstenite's handshake callback signature
    async fn portal() -> (ServerOrigin, Arc<Mutex<u32>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = ServerOrigin::parse(&format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())).unwrap();
        let expected = origin.as_str().to_string();
        let attempts = Arc::new(Mutex::new(0));
        let counted = attempts.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                *counted.lock().unwrap() += 1;
                let expected = expected.clone();
                tokio::spawn(async move {
                    let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                        let header = |name| request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                        if header("Cookie") == "portal=good" && header("Origin") == expected {
                            Ok(response)
                        } else {
                            let mut refused = ErrorResponse::new(None);
                            *refused.status_mut() = StatusCode::UNAUTHORIZED;
                            Err(refused)
                        }
                    };
                    if let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, check).await {
                        socket.send(Message::text(r#"{"kind":"hub.connected"}"#)).await.unwrap();
                        socket.send(Message::text(r#"{"kind":"alert","title":"deploy","body":"shipped","session":"20261024_070707_abcdef"}"#)).await.unwrap();
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                });
            }
        });
        (origin, attempts)
    }

    #[tokio::test]
    async fn a_signed_in_app_hears_alerts_and_a_signed_out_one_waits_for_a_sign_in() {
        let (origin, attempts) = portal().await;
        let cookie = Arc::new(Mutex::new(Some("portal=stale".to_string())));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let wake = Arc::new(Notify::new());
        let task = tokio::spawn({
            let (cookie, heard, wake) = (cookie.clone(), heard.clone(), wake.clone());
            async move { listen(origin, move || cookie.lock().unwrap().clone(), wake, move |a| heard.lock().unwrap().push(a)).await }
        });

        // Refused: no alerts, and no retrying while signed out (the first retry would come at 2s).
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert_eq!(*attempts.lock().unwrap(), 1);
        assert!(heard.lock().unwrap().is_empty());

        // Signing in (a page load with a good cookie) reconnects at once.
        *cookie.lock().unwrap() = Some("portal=good".into());
        wake.notify_one();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while heard.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            *heard.lock().unwrap(),
            [Alert { title: "deploy".into(), body: "shipped".into(), session: Some("20261024_070707_abcdef".into()) }]
        );
        task.abort();
    }
}
