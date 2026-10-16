//! The 10db desktop shell: one window onto the daemon's UI.

/// Starts the shell and blocks until the app quits.
///
/// # Panics
///
/// Panics if the Tauri runtime cannot start; there is no window yet to report the error in.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("the 10db shell failed to start");
}
