fn main() {
    // An app manifest makes every app command ACL-checked, so each window's capability names the
    // commands it may call; the preview's remote capability may call only the pick channel's.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon_connection",
            "update_tray",
            "open_app_page",
            "start_dictation",
            "open_web_link",
            "open_preview",
            "drop_preview_picks",
            "flash_preview_pick",
            "preview_target",
            "add_pick",
            "remove_pick",
            "show_composer",
            "preview_dictation",
        ]),
    ))
    .expect("the Tauri build step failed");
}
