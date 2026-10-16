// Hides the console window on Windows release builds; a no-op on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tendb_desktop_lib::run();
}
