//! Everything OS-specific lives here so core features stay platform-neutral.
//! Porting to Linux/macOS should only ever touch this file.

use tauri::{App, WebviewWindow};
use tauri_plugin_autostart::MacosLauncher;

/// Tray / settings label for the "launch on login" toggle.
pub const AUTOSTART_LABEL: &str = if cfg!(target_os = "windows") {
    "Start with Windows"
} else if cfg!(target_os = "macos") {
    "Open at login"
} else {
    "Start at login"
};

/// macOS conventionally opens the tray menu on left click; elsewhere left click toggles the widget.
pub const TRAY_LEFT_CLICK_TOGGLES: bool = !cfg!(target_os = "macos");

/// How autostart is registered on macOS (ignored elsewhere: Windows uses the HKCU Run key,
/// Linux an XDG autostart .desktop entry).
pub const MACOS_LAUNCHER: MacosLauncher = MacosLauncher::LaunchAgent;

/// App-level tweaks run once at startup.
pub fn setup_app(_app: &mut App) {
    // Menu-bar-only app on macOS: no Dock icon for a desktop widget.
    #[cfg(target_os = "macos")]
    _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Widget-window flags that are set per OS rather than in tauri.conf.json.
pub fn configure_widget_window(window: &WebviewWindow) -> tauri::Result<()> {
    // "On desktop" mode: no taskbar button. (Linux: honoured by most X11 WMs; Wayland may ignore it.)
    window.set_skip_taskbar(true)?;
    // Undecorated windows get a DWM shadow on Windows, which draws a box around the transparent
    // area. (No-op on Linux.)
    window.set_shadow(false)?;
    Ok(())
}
