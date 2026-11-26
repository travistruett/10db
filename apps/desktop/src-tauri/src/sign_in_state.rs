//! The project's kept dev-login cookies, read by the shell for its preview window (Pick on Page spec §2).
//!
//! The daemon writes `<data dir>/browser/<project id>/state.json` (Playwright's storage state, 0600)
//! when it signs in for pictures. The shell reads it itself, so the sign-in never crosses HTTP or the
//! UI's JavaScript, and sets only the cookies for the app's own host into the preview's cookie store.

use std::path::Path;

use serde::Deserialize;
use tauri::webview::cookie::{Cookie, SameSite};

#[derive(Deserialize)]
struct StateCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    #[serde(rename = "httpOnly")]
    http_only: bool,
    secure: bool,
    #[serde(rename = "sameSite")]
    same_site: String,
}

#[derive(Deserialize)]
struct StorageState {
    cookies: Vec<StateCookie>,
}

/// Whether a cookie's domain names `host`: the host itself, with or without a leading dot.
fn names_host(domain: &str, host: &str) -> bool {
    domain.trim_start_matches('.').eq_ignore_ascii_case(host)
}

/// The kept cookies for `host`; none when nothing is kept or the file is not a storage state.
pub fn cookies_for(data_dir: &Path, project_id: &str, host: &str) -> Vec<Cookie<'static>> {
    let path = data_dir.join("browser").join(project_id).join("state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(state) = serde_json::from_str::<StorageState>(&text) else {
        return Vec::new();
    };
    state
        .cookies
        .into_iter()
        .filter(|c| names_host(&c.domain, host))
        .map(|c| {
            let same_site = match c.same_site.as_str() {
                "Strict" => SameSite::Strict,
                "None" => SameSite::None,
                _ => SameSite::Lax,
            };
            Cookie::build((c.name, c.value))
                .domain(host.to_string())
                .path(c.path)
                .http_only(c.http_only)
                .secure(c.secure)
                .same_site(same_site)
                .build()
        })
        .collect()
}
