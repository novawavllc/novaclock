// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;
mod tray;
mod updater;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

const MAIN: &str = "main";
const SETTINGS: &str = "settings";

/// Only geometry is remembered; visibility and always-on-top are driven by settings.
fn window_state_flags() -> StateFlags {
    StateFlags::POSITION | StateFlags::SIZE
}

/// Window-level preferences mirrored on the Rust side so the tray can toggle them.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub always_on_top: bool,
    pub click_through: bool,
    pub autostart: bool,
    /// Not a window setting, but it gates the Rust-side background update checks.
    pub auto_update: bool,
}

#[derive(Default)]
pub struct PrefsState(pub Mutex<Prefs>);

/// WebView2 doesn't fire `visibilitychange` when the window is hidden, so the
/// frontend is told explicitly and pauses its render loops.
fn notify_visibility(app: &AppHandle, visible: bool) {
    // Broadcast: `emit_to` wouldn't reach listeners registered via the global `listen()`.
    let _ = app.emit("widget-visibility", visible);
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        notify_visibility(app, true);
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = app.save_window_state(window_state_flags());
        let _ = w.hide();
        notify_visibility(app, false);
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        if w.is_visible().unwrap_or(false) {
            hide_main(app);
        } else {
            show_main(app);
        }
    }
}

pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        w.unminimize()?;
        w.show()?;
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("NovaClock Settings")
        .inner_size(440.0, 680.0)
        .min_inner_size(360.0, 420.0)
        .center()
        // Let HTML5 drag-and-drop through for reordering (Tauri intercepts it by default).
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

/// Apply window prefs, keeping the shared state and tray checkmarks in sync.
pub fn apply_prefs(app: &AppHandle, wanted: Prefs) -> Result<(), String> {
    let state = app.state::<PrefsState>();
    let mut applied = *state.0.lock().unwrap();

    if let Some(w) = app.get_webview_window(MAIN) {
        w.set_always_on_top(wanted.always_on_top).map_err(|e| e.to_string())?;
        applied.always_on_top = wanted.always_on_top;
        w.set_ignore_cursor_events(wanted.click_through).map_err(|e| e.to_string())?;
        applied.click_through = wanted.click_through;
    }

    applied.auto_update = wanted.auto_update;

    let result = set_autostart(app, wanted.autostart);
    if result.is_ok() {
        applied.autostart = wanted.autostart;
    }

    *state.0.lock().unwrap() = applied;
    tray::sync_checks(app, applied);
    result
}

fn set_autostart(app: &AppHandle, enable: bool) -> Result<(), String> {
    // Don't register the throwaway dev binary to run at login.
    if cfg!(debug_assertions) {
        eprintln!("[dev] autostart -> {enable} (not registered in debug builds)");
        return Ok(());
    }
    let launcher = app.autolaunch();
    let current = launcher.is_enabled().unwrap_or(false);
    match (enable, current) {
        (true, false) => launcher.enable().map_err(|e| e.to_string()),
        (false, true) => launcher.disable().map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

pub fn quit(app: &AppHandle) {
    let _ = app.save_window_state(window_state_flags());
    app.exit(0);
}

#[tauri::command]
fn apply_window_prefs(
    app: AppHandle,
    always_on_top: bool,
    click_through: bool,
    autostart: bool,
    auto_update: bool,
) -> Result<(), String> {
    apply_prefs(&app, Prefs { always_on_top, click_through, autostart, auto_update })
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> updater::UpdateStatus {
    updater::check(&app, true).await
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

#[tauri::command]
fn update_status(app: AppHandle) -> updater::UpdateStatus {
    updater::status(&app)
}

// Async: creating a window from a synchronous command can deadlock on Windows.
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_widget(app: AppHandle) {
    hide_main(&app);
}

#[tauri::command]
fn autostart_label() -> &'static str {
    platform::AUTOSTART_LABEL
}

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch just focuses the running widget.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(platform::MACOS_LAUNCHER, None))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .with_denylist(&[SETTINGS])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PrefsState::default())
        .manage(updater::UpdaterState::default())
        .invoke_handler(tauri::generate_handler![
            apply_window_prefs,
            open_settings,
            hide_widget,
            autostart_label,
            check_for_updates,
            install_update,
            update_status
        ])
        .setup(|app| {
            platform::setup_app(app);
            if let Some(w) = app.get_webview_window(MAIN) {
                platform::configure_widget_window(&w)?;
            }
            tray::create(app.handle())?;
            updater::spawn_background_checks(app.handle().clone());
            // The window starts hidden; the frontend shows it once settings are applied.
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the widget hides it to the tray; only "Quit" exits.
                api.prevent_close();
                hide_main(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running NovaClock");
}
