//! Opening a link from agent text in the default browser, after the builder confirms it.
//!
//! Any `https:` address may open, so the opener's scope, a glob that would open without asking,
//! stays as it is. The shell parses the address and asks in a native dialog that names the parsed
//! host, which a script in the webview can neither skip nor word.

use std::sync::mpsc;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use url::{Position, Url};

/// The address to open, or why it is refused: `https`, a host, and no user name or password.
pub fn web_link(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| format!("{raw}: not an address"))?;
    if url.scheme() != "https" {
        return Err(format!("{raw}: not an https address"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{raw}: carries a user name or password"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("{raw}: names no host"));
    }
    Ok(url)
}

/// The longest address the confirm shows whole, past its scheme and host, in characters.
const SHOWN_ADDRESS_CHARS: usize = 300;
/// How much of a cut address's end the confirm keeps after the ellipsis.
const SHOWN_TAIL_CHARS: usize = 60;

/// The address as the confirm shows it: whole when short; otherwise its scheme and host whole,
/// then the start and the end of the rest around an ellipsis, so an agent's long link can neither
/// fill the dialog nor push its host out of sight.
fn shown_address(url: &Url) -> String {
    let origin = &url[..Position::BeforePath];
    let rest = &url[Position::BeforePath..];
    let count = rest.chars().count();
    if count <= SHOWN_ADDRESS_CHARS {
        return url.as_str().to_owned();
    }
    let head: String = rest
        .chars()
        .take(SHOWN_ADDRESS_CHARS - SHOWN_TAIL_CHARS)
        .collect();
    let tail: String = rest.chars().skip(count - SHOWN_TAIL_CHARS).collect();
    format!("{origin}{head}…{tail}")
}

/// Asks "Open {host} in your browser?" and opens the address on Open. Answers `true` when it
/// opened and `false` on Cancel. The dialog answers on its own thread; the wait for it runs on a
/// blocking thread, so the async runtime is never held.
#[tauri::command]
pub async fn open_web_link(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    let link = web_link(&url)?;
    let host = link.host_str().unwrap_or_default().to_owned();
    let (answer, answered) = mpsc::channel();
    app.dialog()
        .message(shown_address(&link))
        .title(format!("Open {host} in your browser?"))
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open".to_owned(),
            "Cancel".to_owned(),
        ))
        .show(move |open| {
            // The receiver waits until this answer, so the send cannot fail.
            let _ = answer.send(open);
        });
    let open = tauri::async_runtime::spawn_blocking(move || answered.recv().unwrap_or(false))
        .await
        .map_err(|error| error.to_string())?;
    if !open {
        return Ok(false);
    }
    // The plugin's Rust API is not held to the scope its commands check.
    app.opener()
        .open_url(link.as_str(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_a_long_address_cut_in_the_middle_with_its_host_whole() {
        let short = web_link("https://ok.example/a?b=1").unwrap();
        assert_eq!(shown_address(&short), "https://ok.example/a?b=1");

        let tail = "z".repeat(SHOWN_TAIL_CHARS);
        let long = format!("https://ok.example/{}{tail}", "a".repeat(5_000));
        let shown = shown_address(&web_link(&long).unwrap());
        assert!(shown.starts_with("https://ok.example/aaa"), "{shown}");
        assert!(shown.ends_with(&format!("…{tail}")), "{shown}");
        let origin = "https://ok.example".len();
        assert!(
            shown.chars().count() <= origin + SHOWN_ADDRESS_CHARS + 1,
            "{shown}"
        );

        let host = format!("{}.example", "h".repeat(240));
        let long_host = format!("https://{host}/{}", "a".repeat(5_000));
        assert!(
            shown_address(&web_link(&long_host).unwrap()).starts_with(&format!("https://{host}/"))
        );
    }

    #[test]
    fn accepts_https_with_a_host_and_no_credentials() {
        let cases: &[(&str, &str, Option<&str>)] = &[
            ("https", "https://ok.example/a?b=1#c", Some("ok.example")),
            ("upper case", "HTTPS://OK.EXAMPLE/", Some("ok.example")),
            ("http", "http://ok.example/", None),
            ("javascript", "javascript:alert(1)", None),
            ("file", "file:///etc/passwd", None),
            (
                "a user name and password",
                "https://user:pw@ok.example/",
                None,
            ),
            (
                "a user name naming a host",
                "https://github.com@evil.example/",
                None,
            ),
            ("no host", "https:", None),
            // The URL standard reads past extra slashes to a host, as the browser does, and the
            // confirm names that host.
            ("three slashes", "https:///nohost", Some("nohost")),
            ("not an address", "not a url", None),
            (
                "an IDN, named by its punycode",
                "https://аррӏе.com/",
                Some("xn--80ak6aa92e.com"),
            ),
        ];
        for (name, raw, expected) in cases {
            let host = web_link(raw)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned));
            assert_eq!(host.as_deref(), *expected, "{name}");
        }
    }
}
