//! The menu-bar icon: show the window, see lanes, inbox and keep-awake at a glance, quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

/// What the UI reports for the menu bar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrayCounts {
    pub lanes: u32,
    pub inbox: u32,
    pub keep_awake: bool,
}

#[must_use]
pub fn lanes_label(n: u32) -> String {
    match n {
        0 => "No lanes running".to_owned(),
        1 => "1 lane running".to_owned(),
        _ => format!("{n} lanes running"),
    }
}

#[must_use]
pub fn inbox_label(n: u32) -> String {
    match n {
        0 => "Inbox empty".to_owned(),
        1 => "1 card in the inbox".to_owned(),
        _ => format!("{n} cards in the inbox"),
    }
}

#[must_use]
pub fn keep_awake_label(on: bool) -> String {
    let label = if on {
        "Keeping the Mac awake"
    } else {
        "Not keeping the Mac awake"
    };
    label.to_owned()
}

/// Text beside the menu-bar icon. Always none: the wordmark stands alone, and the counts live in the
/// menu rows. Takes the counts so a later status indicator has somewhere to hook in.
#[must_use]
pub fn tray_title(_counts: &TrayCounts) -> Option<String> {
    None
}

/// The tray and its status rows, kept in managed state so `update_tray` can rewrite them.
pub struct TrayItems {
    tray: TrayIcon<Wry>,
    lanes: MenuItem<Wry>,
    inbox: MenuItem<Wry>,
    keep_awake: MenuItem<Wry>,
}

impl TrayItems {
    /// Rewrites the status rows and the title.
    ///
    /// # Errors
    ///
    /// Fails if the menu or tray can't be updated (the app is shutting down).
    pub fn apply(&self, counts: &TrayCounts) -> tauri::Result<()> {
        self.lanes.set_text(lanes_label(counts.lanes))?;
        self.inbox.set_text(inbox_label(counts.inbox))?;
        self.keep_awake
            .set_text(keep_awake_label(counts.keep_awake))?;
        self.tray.set_title(tray_title(counts))
    }
}

/// Shows, unminimizes and focuses the main window.
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus())
    {
        eprintln!("10db: could not show the window: {error}");
    }
}

/// Builds the menu-bar icon and its menu.
///
/// # Errors
///
/// Fails if the menu or tray icon can't be created.
pub fn build(app: &AppHandle) -> tauri::Result<TrayItems> {
    let idle = TrayCounts::default();
    let show = MenuItem::with_id(app, MENU_SHOW, "Show 10db", true, None::<&str>)?;
    let lanes = MenuItem::with_id(app, "lanes", lanes_label(idle.lanes), false, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", inbox_label(idle.inbox), false, None::<&str>)?;
    let keep_awake = MenuItem::with_id(
        app,
        "keep_awake",
        keep_awake_label(idle.keep_awake),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit 10db", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &lanes,
            &inbox,
            &keep_awake,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("10db")
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main_window(app),
            // RunEvent::Exit stops the sidecar before the process ends.
            MENU_QUIT => app.exit(0),
            _ => {}
        });
    // A template image: macOS tints the black wordmark to match the menu bar, like its neighbours.
    let tray = builder
        .icon(tauri::include_image!("tray-icon.png"))
        .icon_as_template(true)
        .build(app)?;
    Ok(TrayItems {
        tray,
        lanes,
        inbox,
        keep_awake,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_read_naturally() {
        assert_eq!(lanes_label(0), "No lanes running");
        assert_eq!(lanes_label(1), "1 lane running");
        assert_eq!(lanes_label(3), "3 lanes running");
        assert_eq!(inbox_label(0), "Inbox empty");
        assert_eq!(inbox_label(1), "1 card in the inbox");
        assert_eq!(inbox_label(12), "12 cards in the inbox");
        assert_eq!(keep_awake_label(true), "Keeping the Mac awake");
        assert_eq!(keep_awake_label(false), "Not keeping the Mac awake");
    }

    #[test]
    fn the_menu_bar_shows_only_the_wordmark() {
        for (lanes, inbox, keep_awake) in [(0, 0, true), (2, 1, true), (0, 4, false), (3, 0, false)]
        {
            assert_eq!(
                tray_title(&TrayCounts {
                    lanes,
                    inbox,
                    keep_awake
                }),
                None,
                "{lanes} lanes, {inbox} cards"
            );
        }
    }
}
