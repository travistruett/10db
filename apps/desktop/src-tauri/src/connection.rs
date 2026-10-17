//! Where the UI finds the daemon: the `daemon.json` and `ui-token` files it writes at start.

use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What the UI needs to reach the running daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonConnection {
    pub url: String,
    pub token: String,
    pub protocol_version: u32,
    pub pid: u32,
}

/// The fields of `daemon.json` the shell uses; the daemon may add more.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    pid: u32,
    port: u16,
    protocol_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionError {
    /// No `daemon.json`: the daemon hasn't started yet or stopped cleanly.
    NotRunning,
    /// A runtime file exists but can't be read.
    Unreadable(String),
    /// A runtime file has unexpected contents.
    Invalid(String),
}

impl fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRunning => f.write_str("The 10db daemon is not running yet."),
            Self::Unreadable(detail) => {
                write!(f, "Could not read the daemon's runtime files: {detail}")
            }
            Self::Invalid(detail) => write!(f, "The daemon's runtime files are invalid: {detail}"),
        }
    }
}

impl std::error::Error for ConnectionError {}

/// The data directory the daemon uses: `TENDB_DATA_DIR`, else `~/Library/Application Support/10db`.
#[must_use]
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TENDB_DATA_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join("Library")
        .join("Application Support")
        .join("10db")
}

/// Reads the daemon's announced port and the UI token from `dir`.
///
/// # Errors
///
/// `NotRunning` when `daemon.json` is absent, `Unreadable` when a file can't be read, and
/// `Invalid` when `daemon.json` doesn't parse or the token is empty.
pub fn read_connection(dir: &Path) -> Result<DaemonConnection, ConnectionError> {
    let info_text = match fs::read_to_string(dir.join("daemon.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(ConnectionError::NotRunning);
        }
        Err(error) => return Err(ConnectionError::Unreadable(format!("daemon.json: {error}"))),
    };
    let info: RuntimeInfo = serde_json::from_str(&info_text)
        .map_err(|error| ConnectionError::Invalid(format!("daemon.json: {error}")))?;
    let token_text = fs::read_to_string(dir.join("ui-token"))
        .map_err(|error| ConnectionError::Unreadable(format!("ui-token: {error}")))?;
    let token = token_text.trim();
    if token.is_empty() {
        return Err(ConnectionError::Invalid("ui-token is empty".to_owned()));
    }
    Ok(DaemonConnection {
        url: format!("http://127.0.0.1:{}", info.port),
        token: token.to_owned(),
        protocol_version: info.protocol_version,
        pid: info.pid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tendb-conn-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn reads_the_runtime_files() {
        let dir = scratch("ok");
        fs::write(
            dir.join("daemon.json"),
            r#"{ "pid": 4242, "port": 51234, "protocolVersion": 1, "startedAt": "2026-10-13T12:00:00.000Z" }"#,
        )
        .expect("write daemon.json");
        fs::write(dir.join("ui-token"), "tok-123\n").expect("write ui-token");
        assert_eq!(
            read_connection(&dir),
            Ok(DaemonConnection {
                url: "http://127.0.0.1:51234".to_owned(),
                token: "tok-123".to_owned(),
                protocol_version: 1,
                pid: 4242,
            })
        );
    }

    #[test]
    fn a_missing_daemon_json_means_not_running() {
        assert_eq!(
            read_connection(&scratch("missing")),
            Err(ConnectionError::NotRunning)
        );
    }

    #[test]
    fn rejects_malformed_json() {
        let dir = scratch("bad-json");
        fs::write(dir.join("daemon.json"), "{ not json").expect("write");
        fs::write(dir.join("ui-token"), "tok").expect("write");
        assert!(matches!(
            read_connection(&dir),
            Err(ConnectionError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_an_empty_token() {
        let dir = scratch("empty-token");
        fs::write(
            dir.join("daemon.json"),
            r#"{ "pid": 1, "port": 2, "protocolVersion": 1, "startedAt": "x" }"#,
        )
        .expect("write");
        fs::write(dir.join("ui-token"), "  \n").expect("write");
        assert!(matches!(
            read_connection(&dir),
            Err(ConnectionError::Invalid(_))
        ));
    }

    #[test]
    fn a_missing_token_is_unreadable() {
        let dir = scratch("no-token");
        fs::write(
            dir.join("daemon.json"),
            r#"{ "pid": 1, "port": 2, "protocolVersion": 1, "startedAt": "x" }"#,
        )
        .expect("write");
        assert!(matches!(
            read_connection(&dir),
            Err(ConnectionError::Unreadable(_))
        ));
    }

    #[test]
    fn serializes_camel_case_for_the_ui() {
        let conn = DaemonConnection {
            url: "u".to_owned(),
            token: "t".to_owned(),
            protocol_version: 1,
            pid: 7,
        };
        let json = serde_json::to_string(&conn).expect("serialize");
        assert_eq!(
            json,
            r#"{"url":"u","token":"t","protocolVersion":1,"pid":7}"#
        );
    }
}
