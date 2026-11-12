//! Opening one page of a project's app in the default browser.
//!
//! The opener plugin's scope is a glob over the URL string, which cannot tell a host from a
//! userinfo or a path, so the window's capability names no `http` address. This module parses the
//! address instead and opens only a loopback one, through the plugin's Rust API, which is not
//! scope-checked.

use std::fmt;

use url::{Host, Url};

/// Why an address was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NotAnAddress,
    NotHttp,
    HasCredentials,
    NotLoopback,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotAnAddress => "not an address",
            Self::NotHttp => "not an http or https address",
            Self::HasCredentials => "carries a user name or password",
            Self::NotLoopback => "not a loopback address",
        })
    }
}

/// The address to open, or why it is refused: `http` or `https`, no user name or password, and a
/// host that is exactly `localhost`, `127.0.0.1`, `::1` or a name under `.localhost`.
pub fn loopback_page(raw: &str) -> Result<Url, Refusal> {
    let url = Url::parse(raw).map_err(|_| Refusal::NotAnAddress)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(Refusal::NotHttp);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Refusal::HasCredentials);
    }
    let loopback = match url.host() {
        Some(Host::Domain(name)) => name == "localhost" || name.ends_with(".localhost"),
        Some(Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    if loopback {
        Ok(url)
    } else {
        Err(Refusal::NotLoopback)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_refuses_by_parsed_host() {
        let cases: &[(&str, &str, Result<(), Refusal>)] = &[
            (
                "localhost with a port",
                "http://localhost:8800/a?b=1",
                Ok(()),
            ),
            ("127.0.0.1", "http://127.0.0.1:3000/", Ok(())),
            ("::1", "http://[::1]:5173/x", Ok(())),
            ("a .localhost name", "http://app.localhost:8800/", Ok(())),
            ("https on loopback", "https://localhost:8443/", Ok(())),
            (
                "userinfo naming another host",
                "http://localhost:1@evil.example/",
                Err(Refusal::HasCredentials),
            ),
            (
                "a path that reads as a host",
                "http://evil.example/a.localhost/b",
                Err(Refusal::NotLoopback),
            ),
            (
                "a look-alike suffix",
                "http://evil.example/localhost",
                Err(Refusal::NotLoopback),
            ),
            (
                "a look-alike prefix",
                "http://localhost.evil.example/",
                Err(Refusal::NotLoopback),
            ),
            (
                "another IPv6 address",
                "http://[::2]:80/",
                Err(Refusal::NotLoopback),
            ),
            (
                "another 127 address",
                "http://127.0.0.2/",
                Err(Refusal::NotLoopback),
            ),
            ("file", "file:///etc/passwd", Err(Refusal::NotHttp)),
            ("javascript", "javascript:alert(1)", Err(Refusal::NotHttp)),
            ("not an address", "/just/a/path", Err(Refusal::NotAnAddress)),
        ];
        for (name, raw, expected) in cases {
            assert_eq!(loopback_page(raw).map(|_| ()), *expected, "{name}");
        }
    }
}
