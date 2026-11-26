//! The Preview window: a project's app in a 10db window, with the picker, and the one channel from it
//! into the main window (Pick on Page spec §2, §5).
//!
//! The page runs agent-written code in the picker's own JavaScript world, so every call from it is
//! data from an untrusted source. The shell keeps which page a window's picks go to, checks the
//! calling window and its origin, parses and caps each pick (`pick_rules`), and emits it to the main
//! window alone, where it can only become a chip in that page's draft. No call from the page sends,
//! answers or starts anything.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::app_page;
use crate::pick_rules::{self, Pick, PickRate, PickRefusal};
use crate::snapshot;

/// The main window's label: the only window picks are emitted to.
const MAIN: &str = "main";
const LABEL_PREFIX: &str = "preview-";
const PAGE_LABEL_MAX: usize = 120;
/// The largest crop sent, under what the UI parses (8 MiB of base64).
const CROP_MAX_BYTES: usize = 6 * 1024 * 1024;

/// How many picks' targets a window remembers; older ones are dropped, and a late update for one is too.
const TARGETS_MAX: usize = 64;
/// The least time between two `show_composer` calls a window makes.
const SHOW_EVERY: Duration = Duration::from_secs(1);

struct Preview {
    project_id: String,
    origin: Url,
    /// The page picks made from now on go to.
    task_id: String,
    page_label: String,
    rate: PickRate,
    /// Each pick's page, fixed when the pick is first made, so an edit never moves it to another page.
    targets: HashMap<String, String>,
    made: VecDeque<String>,
    last_show: Option<Instant>,
}

impl Preview {
    /// The page a pick goes to: the one it was first made for, or the window's target now.
    fn target_of(&mut self, pick_id: &str) -> String {
        if let Some(task) = self.targets.get(pick_id) {
            return task.clone();
        }
        if self.made.len() >= TARGETS_MAX
            && let Some(oldest) = self.made.pop_front()
        {
            self.targets.remove(&oldest);
        }
        self.made.push_back(pick_id.to_string());
        self.targets
            .insert(pick_id.to_string(), self.task_id.clone());
        self.task_id.clone()
    }
}

/// The open preview windows, by window label, and the capabilities already added for them.
#[derive(Default)]
pub struct Previews {
    windows: Mutex<HashMap<String, Preview>>,
    capabilities: Mutex<BTreeSet<String>>,
}

/// The only app commands a preview's page may call. Each checks the window and the page's origin
/// again; none sends, answers or starts anything.
pub const PREVIEW_PERMISSIONS: [&str; 5] = [
    "allow-preview-target",
    "allow-add-pick",
    "allow-remove-pick",
    "allow-show-composer",
    "allow-preview-dictation",
];

/// Lets the preview window's page, on the app's exact origin only, call the pick channel.
fn allow_channel(
    app: &AppHandle,
    previews: &Previews,
    label: &str,
    origin: &Url,
) -> Result<(), String> {
    let origin = origin.origin().ascii_serialization();
    let identifier = format!("{label}-{}", origin.replace(['/', ':', '.', '[', ']'], "-"));
    let mut added = previews.capabilities.lock().map_err(|e| e.to_string())?;
    if added.contains(&identifier) {
        return Ok(());
    }
    let mut capability = CapabilityBuilder::new(identifier.clone())
        .window(label)
        .remote(format!("{origin}/*"));
    for permission in PREVIEW_PERMISSIONS {
        capability = capability.permission(permission);
    }
    app.add_capability(capability).map_err(|e| e.to_string())?;
    added.insert(identifier);
    Ok(())
}

/// `prj_` or `tsk_` and a lower-case UUID, the form `@10db/contracts` mints.
fn valid_id(id: &str, prefix: &str) -> bool {
    let Some(uuid) = id
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('_'))
    else {
        return false;
    };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// The project's UUID as the 16 bytes of the window's own `WebKit` data store.
fn data_store_id(project_id: &str) -> [u8; 16] {
    let hex: Vec<u8> = project_id
        .trim_start_matches("prj_")
        .bytes()
        .filter(u8::is_ascii_hexdigit)
        .collect();
    let mut bytes = [0u8; 16];
    for (i, pair) in hex.chunks(2).take(16).enumerate() {
        let text = std::str::from_utf8(pair).unwrap_or("0");
        bytes[i] = u8::from_str_radix(text, 16).unwrap_or(0);
    }
    bytes
}

/// The picker as the window's initialization script: it does nothing outside the app's origin or in
/// a frame.
fn init_script(origin: &Url, repo_path: &str, picker: &str) -> String {
    let config = serde_json::json!({
        "origin": origin.origin().ascii_serialization(),
        "repoPath": repo_path,
    });
    format!(
        "(() => {{ const __tendbPreview = {config}; if (window.top !== window || location.origin !== __tendbPreview.origin) return;\n{picker}\n}})();"
    )
}

/// Opens, or reuses, the project's preview on `route`, making `task_id`'s page the window's target.
/// Called by the main window, which passes the picker script it bundles.
#[allow(clippy::needless_pass_by_value, clippy::too_many_arguments)]
#[tauri::command]
pub async fn open_preview(
    app: AppHandle,
    previews: State<'_, Previews>,
    project_id: String,
    app_url: String,
    route: String,
    task_id: String,
    page_label: String,
    repo_path: String,
    picker: String,
) -> Result<(), String> {
    if !valid_id(&project_id, "prj") || !valid_id(&task_id, "tsk") {
        return Err("not a project and page of 10db".into());
    }
    let origin =
        app_page::loopback_page(&app_url).map_err(|refusal| format!("{app_url}: {refusal}"))?;
    let address = origin
        .join(&route)
        .map_err(|_| format!("{route}: not a route"))?;
    if !pick_rules::same_origin(&address, &origin) {
        return Err(format!("{route}: not a route of the app"));
    }
    let page_label: String = page_label.chars().take(PAGE_LABEL_MAX).collect();
    let label = format!("{LABEL_PREFIX}{project_id}");
    let title = format!("{page_label} · Mark Up");

    allow_channel(&app, &previews, &label, &origin)?;
    let same_origin_window = {
        let mut map = previews.windows.lock().map_err(|e| e.to_string())?;
        let reuse = map
            .get(&label)
            .is_some_and(|p| pick_rules::same_origin(&p.origin, &origin));
        map.insert(
            label.clone(),
            Preview {
                project_id: project_id.clone(),
                origin: origin.clone(),
                task_id,
                page_label,
                rate: PickRate::default(),
                targets: HashMap::new(),
                made: VecDeque::new(),
                last_show: None,
            },
        );
        reuse
    };

    if let Some(window) = app.get_webview_window(&label) {
        if same_origin_window {
            window.set_title(&title).map_err(|e| e.to_string())?;
            window.navigate(address).map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        // The app's address changed: the script and the navigation rule hold the old origin.
        window.destroy().map_err(|e| e.to_string())?;
    }

    let popup_app = app.clone();
    let popup_label = label.clone();
    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External("about:blank".parse().map_err(|_| "about:blank")?),
    )
    .title(&title)
    .inner_size(1280.0, 860.0)
    .min_inner_size(420.0, 400.0)
    .data_store_identifier(data_store_id(&project_id))
    .initialization_script(init_script(&origin, &repo_path, &picker))
    // The preview browses like a browser: only the app's own origin reaches the pick channel, and a
    // new window loads in the preview itself, never in the builder's own browser.
    .on_new_window(move |url, _features| {
        if matches!(url.scheme(), "http" | "https")
            && let Some(window) = popup_app.get_webview_window(&popup_label)
        {
            let _ = window.navigate(url);
        }
        NewWindowResponse::Deny
    })
    .build()
    .map_err(|e| e.to_string())?;

    if let Some(host) = origin.host_str() {
        for cookie in
            crate::sign_in_state::cookies_for(&crate::connection::data_dir(), &project_id, host)
        {
            window.set_cookie(cookie).map_err(|e| e.to_string())?;
        }
    }
    window.navigate(address).map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs one of the picker's own calls in a project's preview, its arguments serialized as JSON.
fn call_picker(
    app: &AppHandle,
    project_id: &str,
    call: &str,
    args: &serde_json::Value,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&format!("{LABEL_PREFIX}{project_id}")) {
        window
            .eval(format!("window.__tendbPicker?.{call}(...{args});"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drops picks from a project's preview, once sent or removed from the draft or refused by it, and
/// shows `notice` there when there is one.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn drop_preview_picks(
    app: AppHandle,
    project_id: String,
    pick_ids: Vec<String>,
    notice: Option<String>,
) -> Result<(), String> {
    if !valid_id(&project_id, "prj") {
        return Err("not a project of 10db".into());
    }
    let dropped: Vec<String> = pick_ids
        .into_iter()
        .filter(|id| pick_rules::valid_id(id))
        .collect();
    let notice: Option<String> = notice.map(|n| n.chars().take(200).collect());
    call_picker(
        &app,
        &project_id,
        "drop",
        &serde_json::json!([dropped, notice]),
    )
}

/// Flashes a pick's badge in the preview, for a click on its chip.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn flash_preview_pick(
    app: AppHandle,
    project_id: String,
    pick_id: String,
) -> Result<(), String> {
    if !valid_id(&project_id, "prj") || !pick_rules::valid_id(&pick_id) {
        return Err("not a pick of 10db".into());
    }
    if let Some(window) = app.get_webview_window(&format!("{LABEL_PREFIX}{project_id}")) {
        window.show().map_err(|e| e.to_string())?;
    }
    call_picker(&app, &project_id, "flash", &serde_json::json!([pick_id]))
}

/// What a pick's arrival tells the main window.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PickArrived {
    project_id: String,
    task_id: String,
    pick: Pick,
    /// The crop as base64 PNG; none when `WebKit` gave none.
    crop: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PickRemoved {
    task_id: String,
    pick_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShowComposer {
    task_id: String,
}

/// What the page is told: the page its picks go to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    page: String,
}

/// The calling window's preview, once its label and its page's origin check out.
fn checked<'a, R: tauri::Runtime>(
    map: &'a mut HashMap<String, Preview>,
    webview: &tauri::Webview<R>,
) -> Result<&'a mut Preview, PickRefusal> {
    let preview = map
        .get_mut(webview.label())
        .ok_or(PickRefusal::NotThisWindow)?;
    let url = webview.url().map_err(|_| PickRefusal::WrongOrigin)?;
    if !pick_rules::same_origin(&url, &preview.origin) {
        return Err(PickRefusal::WrongOrigin);
    }
    Ok(preview)
}

/// The page its picks go to, for the pill.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn preview_target(
    webview: tauri::Webview,
    previews: State<'_, Previews>,
) -> Result<PreviewTarget, String> {
    let mut map = previews.windows.lock().map_err(|e| e.to_string())?;
    let preview = checked(&mut map, &webview).map_err(|r| r.to_string())?;
    Ok(PreviewTarget {
        page: preview.page_label.clone(),
    })
}

/// A pick from the page: checked, cropped and handed to the main window as data for one page's draft.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn add_pick(
    app: AppHandle,
    webview: tauri::Webview,
    previews: State<'_, Previews>,
    pick: String,
) -> Result<PreviewTarget, String> {
    let (project_id, task_id, page, parsed) = {
        let mut map = previews.windows.lock().map_err(|e| e.to_string())?;
        let preview = checked(&mut map, &webview).map_err(|r| r.to_string())?;
        let parsed = pick_rules::parse_pick(&pick).map_err(|r| r.to_string())?;
        if !preview.rate.allow(Instant::now()) {
            return Err(PickRefusal::TooFast.to_string());
        }
        let task_id = preview.target_of(&parsed.id);
        (
            preview.project_id.clone(),
            task_id,
            preview.page_label.clone(),
            parsed,
        )
    };
    let crop = match parsed.crop_rect() {
        Some(rect) => {
            let shot = webview.clone();
            let dpr = parsed.viewport.dpr;
            tauri::async_runtime::spawn_blocking(move || snapshot::take(&shot, rect, dpr))
                .await
                .ok()
                .flatten()
                // A crop the UI would refuse goes as none, so the pick still arrives.
                .filter(|png| png.len() <= CROP_MAX_BYTES)
                .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
        }
        None => None,
    };
    app.emit_to(
        MAIN,
        "preview-pick",
        PickArrived {
            project_id,
            task_id,
            pick: parsed,
            crop,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(PreviewTarget { page })
}

/// The page dropped a pick: its chip goes too.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remove_pick(
    app: AppHandle,
    webview: tauri::Webview,
    previews: State<'_, Previews>,
    pick_id: String,
) -> Result<(), String> {
    if !pick_rules::valid_id(&pick_id) {
        return Err("not a pick".into());
    }
    let task_id = {
        let mut map = previews.windows.lock().map_err(|e| e.to_string())?;
        let preview = checked(&mut map, &webview).map_err(|r| r.to_string())?;
        let Some(task_id) = preview.targets.get(&pick_id).cloned() else {
            return Ok(());
        };
        task_id
    };
    app.emit_to(
        MAIN,
        "preview-pick-removed",
        PickRemoved { task_id, pick_id },
    )
    .map_err(|e| e.to_string())
}

/// Brings 10db forward on the target page's picks, never its input, so no keystroke the builder is
/// typing lands in the draft; it sends nothing.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn show_composer(
    app: AppHandle,
    webview: tauri::Webview,
    previews: State<'_, Previews>,
) -> Result<(), String> {
    // Only while the builder is in the preview, so the page can't pull 10db forward under their typing.
    if !webview.window().is_focused().unwrap_or(false) {
        return Err("the preview is not in front".into());
    }
    let task_id = {
        let mut map = previews.windows.lock().map_err(|e| e.to_string())?;
        let preview = checked(&mut map, &webview).map_err(|r| r.to_string())?;
        let now = Instant::now();
        if preview
            .last_show
            .is_some_and(|last| now.duration_since(last) < SHOW_EVERY)
        {
            return Err(PickRefusal::TooFast.to_string());
        }
        preview.last_show = Some(now);
        preview.task_id.clone()
    };
    // The main window brings itself forward on this event, marking the focus as the preview's first,
    // so its composer's input doesn't take the cursor.
    app.emit_to(MAIN, "preview-show-composer", ShowComposer { task_id })
        .map_err(|e| e.to_string())
}

/// Starts macOS Dictation in the note the builder is typing. Only while the preview is in front, so
/// the page can't start it in a window the builder is using.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn preview_dictation(
    app: AppHandle,
    webview: tauri::Webview,
    previews: State<'_, Previews>,
) -> Result<(), String> {
    if !webview.window().is_focused().unwrap_or(false) {
        return Err("the preview is not in front".into());
    }
    {
        let mut map = previews.windows.lock().map_err(|e| e.to_string())?;
        checked(&mut map, &webview).map_err(|r| r.to_string())?;
    }
    crate::dictation::start_dictation(app)
}

/// Forgets a preview once its window is gone.
pub fn forget(previews: &Previews, label: &str) {
    if let Ok(mut map) = previews.windows.lock() {
        map.remove(label);
    }
}

/// Whether a window is a preview, which closes for real rather than hiding as the main window does.
pub fn is_preview(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_holds_app_commands_and_never_the_pick_channel() {
        let default: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("the main window's capability");
        assert_eq!(default["windows"], serde_json::json!(["main"]));
        let granted: Vec<&str> = default["permissions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .collect();
        for permission in PREVIEW_PERMISSIONS {
            assert!(!granted.contains(&permission), "main holds {permission}");
        }
        assert!(valid_id("prj_0193f1a2-7b3c-7def-8a01-23456789abcd", "prj"));
        assert!(!valid_id("prj_../../etc", "prj"));
        assert!(!valid_id("tsk_0193f1a2-7b3c-7def-8a01-23456789abcd", "prj"));
    }
}
