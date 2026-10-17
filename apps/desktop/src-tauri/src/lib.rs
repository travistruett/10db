//! The 10db desktop shell: a menu-bar app that supervises the daemon and shows its UI.

mod connection;
mod supervisor;
mod tray;

use tauri::{Manager, RunEvent, State, WindowEvent};

use connection::DaemonConnection;
use supervisor::Supervisor;
use tray::{TrayCounts, TrayItems};

/// The sidecar supervisor; `None` when a development daemon runs outside the app.
struct Sidecar(Option<Supervisor>);

/// Where the UI connects: the port and token the running daemon announced. Async so the file
/// reads run off the main thread.
#[tauri::command]
async fn daemon_connection() -> Result<DaemonConnection, String> {
    connection::read_connection(&connection::data_dir()).map_err(|error| error.to_string())
}

/// The UI reports lanes, open cards and keep-awake; the tray shows them.
// Tauri hands command arguments over by value.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn update_tray(
    items: State<'_, TrayItems>,
    lanes: u32,
    inbox: u32,
    keep_awake: bool,
) -> Result<(), String> {
    items
        .apply(&TrayCounts {
            lanes,
            inbox,
            keep_awake,
        })
        .map_err(|error| error.to_string())
}

fn external_daemon() -> bool {
    std::env::var("TENDB_EXTERNAL_DAEMON").is_ok_and(|value| value == "1")
}

/// Starts the shell and blocks until the app quits.
///
/// # Panics
///
/// Panics if the Tauri runtime cannot start; there is no window yet to report the error in.
pub fn run() {
    let app = tauri::Builder::default()
        // Registered first so a second launch is caught before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![daemon_connection, update_tray])
        .setup(|app| {
            let items = tray::build(app.handle())?;
            app.manage(items);
            let supervisor = if external_daemon() {
                None
            } else {
                Some(Supervisor::start(
                    app.path().resource_dir()?,
                    connection::data_dir().join("logs"),
                ))
            };
            app.manage(Sidecar(supervisor));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps work running (spec §3); Quit is in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("10db: could not hide the window: {error}");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("the 10db shell failed to start");

    app.run(|handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => tray::show_main_window(handle),
        RunEvent::Exit => {
            if let Some(supervisor) = &handle.state::<Sidecar>().0 {
                supervisor.stop();
            }
        }
        _ => {}
    });
}
