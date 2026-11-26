//! What the preview window may hand the shell, decided without the window (Pick on Page spec §5).
//!
//! A pick comes from a page running agent-written code, so everything here is data from an untrusted
//! source: its size is capped before it is parsed, every field is capped as it is parsed, a source path
//! outside the project is dropped, and the calls a window makes are rate-limited. The target page is
//! never read from the pick: the shell keeps it.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The longest pick, as JSON text, the shell reads.
pub const PICK_MAX_BYTES: usize = 64 * 1024;
/// The most elements one pick names.
pub const PICK_ELEMENTS_MAX: usize = 6;

const NOTE_MAX: usize = 2_000;
const TEXT_MAX: usize = 200;
const SELECTOR_MAX: usize = 500;
const TAG_MAX: usize = 40;
const COMPONENT_MAX: usize = 120;
const FILE_MAX: usize = 300;
const ROUTE_MAX: usize = 512;
const ENGINE_MAX: usize = 80;
const ID_MAX: usize = 64;
/// A box's coordinates stay within this many CSS pixels of the origin.
const COORD_MAX: f64 = 100_000.0;

/// Why a call from the preview was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum PickRefusal {
    NotThisWindow,
    WrongOrigin,
    TooLarge,
    Malformed(String),
    TooFast,
}

impl std::fmt::Display for PickRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotThisWindow => f.write_str("not a preview window"),
            Self::WrongOrigin => f.write_str("the page is not the project's app"),
            Self::TooLarge => f.write_str("the pick is too large"),
            Self::Malformed(why) => write!(f, "the pick is malformed: {why}"),
            Self::TooFast => f.write_str("picks are arriving too fast"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickKind {
    Element,
    Group,
    Area,
}

/// A box in the page's viewport, in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRef {
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PickElement {
    pub tag: String,
    pub selector: String,
    pub text: String,
    pub rect: Rect,
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default)]
    pub source: Option<SourceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub dpr: f64,
}

/// One pick, as the page sends it and as the shell forwards it once checked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pick {
    pub id: String,
    pub kind: PickKind,
    pub elements: Vec<PickElement>,
    /// The dragged box of an area pick.
    #[serde(default)]
    pub area: Option<Rect>,
    pub note: String,
    pub route: String,
    pub viewport: Viewport,
    pub engine: String,
}

impl Pick {
    /// The box the crop is taken of: an area's box, or the union of its elements' boxes.
    pub fn crop_rect(&self) -> Option<Rect> {
        if let Some(area) = self.area {
            return Some(area);
        }
        let mut boxes = self.elements.iter().map(|e| e.rect);
        let first = boxes.next()?;
        Some(boxes.fold(first, |a, b| {
            let x = a.x.min(b.x);
            let y = a.y.min(b.y);
            Rect {
                x,
                y,
                width: (a.x + a.width).max(b.x + b.width) - x,
                height: (a.y + a.height).max(b.y + b.height) - y,
            }
        }))
    }
}

/// A pick id: what the page mints, kept short and plain because the UI keys chips by it.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn capped(field: &str, value: &str, max: usize) -> Result<(), PickRefusal> {
    if value.chars().count() > max {
        return Err(PickRefusal::Malformed(format!(
            "{field} is over {max} characters"
        )));
    }
    Ok(())
}

fn finite_rect(field: &str, rect: &Rect) -> Result<(), PickRefusal> {
    let all = [rect.x, rect.y, rect.width, rect.height];
    if all.iter().any(|v| !v.is_finite() || v.abs() > COORD_MAX)
        || rect.width < 0.0
        || rect.height < 0.0
    {
        return Err(PickRefusal::Malformed(format!("{field} is not a box")));
    }
    Ok(())
}

/// A source path the agent may be pointed at: relative to the project, inside it, and not a
/// dependency's or a build's output. Anything else is dropped, never sent.
pub fn project_source(file: &str) -> bool {
    if file.is_empty() || file.len() > FILE_MAX || file.contains('\\') || file.contains('\0') {
        return false;
    }
    if file.starts_with('/') || file.contains("://") || file.starts_with('~') {
        return false;
    }
    !file.split('/').any(|segment| {
        matches!(
            segment,
            "" | "." | ".." | "node_modules" | ".next" | "dist" | ".turbo"
        )
    })
}

/// Parses a pick from its JSON text, refusing what is too large or malformed, and dropping a source
/// path outside the project.
pub fn parse_pick(json: &str) -> Result<Pick, PickRefusal> {
    if json.len() > PICK_MAX_BYTES {
        return Err(PickRefusal::TooLarge);
    }
    let mut pick: Pick =
        serde_json::from_str(json).map_err(|error| PickRefusal::Malformed(error.to_string()))?;
    if !valid_id(&pick.id) {
        return Err(PickRefusal::Malformed("id".into()));
    }
    if pick.elements.len() > PICK_ELEMENTS_MAX {
        return Err(PickRefusal::Malformed("too many elements".into()));
    }
    if pick.elements.is_empty() && pick.area.is_none() {
        return Err(PickRefusal::Malformed("picks nothing".into()));
    }
    capped("note", &pick.note, NOTE_MAX)?;
    capped("route", &pick.route, ROUTE_MAX)?;
    capped("engine", &pick.engine, ENGINE_MAX)?;
    if !pick.route.starts_with('/') {
        return Err(PickRefusal::Malformed("route".into()));
    }
    let v = pick.viewport;
    if [v.width, v.height, v.dpr]
        .iter()
        .any(|n| !n.is_finite() || *n <= 0.0 || *n > COORD_MAX)
    {
        return Err(PickRefusal::Malformed("viewport".into()));
    }
    if let Some(area) = &pick.area {
        finite_rect("area", area)?;
    }
    for element in &mut pick.elements {
        capped("tag", &element.tag, TAG_MAX)?;
        capped("selector", &element.selector, SELECTOR_MAX)?;
        capped("text", &element.text, TEXT_MAX)?;
        finite_rect("rect", &element.rect)?;
        if let Some(component) = &element.component {
            capped("component", component, COMPONENT_MAX)?;
        }
        if element
            .source
            .as_ref()
            .is_some_and(|source| !project_source(&source.file))
        {
            element.source = None;
        }
    }
    Ok(pick)
}

/// Whether `url`'s origin is exactly `origin` (scheme, host and port).
pub fn same_origin(url: &url::Url, origin: &url::Url) -> bool {
    url.origin() == origin.origin()
}

/// At most two picks a second and thirty a minute from one window.
#[derive(Debug, Default)]
pub struct PickRate {
    recent: VecDeque<Instant>,
}

const PER_SECOND: usize = 2;
const PER_MINUTE: usize = 30;

impl PickRate {
    /// Records a call at `now` and says whether it is allowed; a refused call is not recorded.
    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            self.recent.pop_front();
        }
        let last_second = self
            .recent
            .iter()
            .filter(|t| now.duration_since(**t) < Duration::from_secs(1))
            .count();
        if last_second >= PER_SECOND || self.recent.len() >= PER_MINUTE {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick_json(overrides: &str) -> String {
        let base = serde_json::json!({
            "id": "p1",
            "kind": "element",
            "elements": [{
                "tag": "button",
                "selector": "main > button",
                "text": "Save",
                "rect": { "x": 10.0, "y": 20.0, "width": 80.0, "height": 30.0 },
                "component": "SaveButton",
                "source": { "file": "app/settings/card.tsx", "line": 37 }
            }],
            "note": "make it secondary",
            "route": "/settings",
            "viewport": { "width": 1280.0, "height": 800.0, "dpr": 2.0 },
            "engine": "WebKit"
        });
        let mut value = base;
        let patch: serde_json::Value = serde_json::from_str(overrides).expect("a JSON patch");
        if let (Some(target), Some(patch)) = (value.as_object_mut(), patch.as_object()) {
            for (key, v) in patch {
                target.insert(key.clone(), v.clone());
            }
        }
        value.to_string()
    }

    #[test]
    fn parses_caps_and_drops_by_rule() {
        let long_note = pick_json(&format!(r#"{{"note": "{}"}}"#, "x".repeat(2_001)));
        let cases: &[(&str, String, Result<(), PickRefusal>)] = &[
            ("a plain pick", pick_json("{}"), Ok(())),
            (
                "an unknown field",
                pick_json(r#"{"taskId": "tsk_1"}"#),
                Err(PickRefusal::Malformed(String::new())),
            ),
            ("a note over the cap", long_note, Err(PickRefusal::Malformed(String::new()))),
            (
                "an id with other characters",
                pick_json(r#"{"id": "p 1"}"#),
                Err(PickRefusal::Malformed(String::new())),
            ),
            (
                "nothing picked",
                pick_json(r#"{"elements": []}"#),
                Err(PickRefusal::Malformed(String::new())),
            ),
            (
                "a route that is an address",
                pick_json(r#"{"route": "https://evil.example/"}"#),
                Err(PickRefusal::Malformed(String::new())),
            ),
            (
                "a viewport that is not finite",
                pick_json(r#"{"viewport": {"width": 0, "height": 800, "dpr": 2}}"#),
                Err(PickRefusal::Malformed(String::new())),
            ),
            (
                "seven elements",
                pick_json(&format!(
                    r#"{{"elements": [{}]}}"#,
                    [r#"{"tag":"a","selector":"a","text":"","rect":{"x":0,"y":0,"width":1,"height":1}}"#; 7].join(",")
                )),
                Err(PickRefusal::Malformed(String::new())),
            ),
            ("too large", format!("{{\"x\":\"{}\"}}", "y".repeat(PICK_MAX_BYTES)), Err(PickRefusal::TooLarge)),
        ];
        for (name, json, expected) in cases {
            let got = parse_pick(json).map(|_| ());
            match (expected, &got) {
                (Err(PickRefusal::Malformed(_)), Err(PickRefusal::Malformed(_))) => {}
                _ => assert_eq!(&got, expected, "{name}"),
            }
        }

        let sources: &[(&str, bool)] = &[
            ("app/settings/card.tsx", true),
            ("src/components/a.tsx", true),
            ("/Users/me/app/card.tsx", false),
            ("../outside.tsx", false),
            ("app/../../etc/passwd", false),
            ("node_modules/@mantine/core/Box.tsx", false),
            (".next/server/chunks/x.js", false),
            ("file:///frontend/app/page.tsx", false),
            ("app\\page.tsx", false),
            ("", false),
        ];
        for (file, kept) in sources {
            let json = pick_json(&format!(
                r#"{{"elements": [{{"tag":"a","selector":"a","text":"","rect":{{"x":0,"y":0,"width":1,"height":1}},"source":{{"file":{},"line":3}}}}]}}"#,
                serde_json::Value::String((*file).to_string())
            ));
            let pick = parse_pick(&json).expect("a pick whose source is dropped, not refused");
            assert_eq!(pick.elements[0].source.is_some(), *kept, "{file}");
        }
    }

    #[test]
    fn rate_allows_two_a_second_and_thirty_a_minute() {
        let start = Instant::now();
        let mut rate = PickRate::default();
        assert!(rate.allow(start));
        assert!(rate.allow(start));
        assert!(
            !rate.allow(start + Duration::from_millis(500)),
            "a third in one second"
        );
        let mut allowed = 2;
        for second in 1..120 {
            if rate.allow(start + Duration::from_secs(second)) {
                allowed += 1;
            }
            if second < 60 {
                assert!(allowed <= PER_MINUTE, "at most thirty in the first minute");
            }
        }
        assert!(allowed > PER_MINUTE, "the minute's window moves on");
    }
}
