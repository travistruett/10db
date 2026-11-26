//! Starting macOS Dictation in the focused text field, the same as Edit > Start Dictation.
//!
//! The UI focuses its input first; the shell then sends `startDictation:` down the responder chain
//! from the application, which reaches the focused field. That needs no Accessibility permission,
//! unlike synthesizing the fn-fn shortcut.

/// Asks the focused responder to start dictation. A no-op where there is no such responder chain.
// Tauri hands command arguments over by value.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn start_dictation(app: tauri::AppHandle) -> Result<(), String> {
    app.run_on_main_thread(send_start_dictation)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
// The one call into AppKit the shell makes; `sendAction:to:from:` is unsafe only because its
// selector is unchecked, and `startDictation:` is the selector AppKit's own Edit menu sends.
#[allow(unsafe_code)]
pub(crate) fn send_start_dictation() {
    use objc2::{MainThreadMarker, sel};
    use objc2_app_kit::NSApplication;

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let application = NSApplication::sharedApplication(main_thread);
    // SAFETY: `startDictation:` takes one optional sender and no other argument, and a nil target
    // sends it to the first responder that implements it.
    unsafe {
        application.sendAction_to_from(sel!(startDictation:), None, None);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn send_start_dictation() {}
