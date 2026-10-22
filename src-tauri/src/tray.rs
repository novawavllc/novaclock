//! System tray icon and menu.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{platform, updater::UpdateStatus, Prefs, PrefsState};

/// Handles to the checkable items so their state can follow changes made in the settings window.
pub struct TrayItems {
    always_on_top: CheckMenuItem<Wry>,
    click_through: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    update: MenuItem<Wry>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show/Hide widget", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let always_on_top = CheckMenuItem::with_id(app, "always_on_top", "Always on top", true, false, None::<&str>)?;
    // Also lives here because a click-through widget can't be clicked to turn it off.
    let click_through = CheckMenuItem::with_id(app, "click_through", "Click-through", true, false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", platform::AUTOSTART_LABEL, true, false, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", update_label(&UpdateStatus::Idle), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);

    let menu = Menu::with_items(
        app,
        &[&toggle, &settings, &sep()?, &always_on_top, &click_through, &autostart, &sep()?, &update, &quit],
    )?;

    app.manage(TrayItems { always_on_top, click_through, autostart, update });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("NovaClock")
        .menu(&menu)
        .show_menu_on_left_click(!platform::TRAY_LEFT_CLICK_TOGGLES)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => crate::toggle_main(app),
            "settings" => {
                if let Err(e) = crate::show_settings(app) {
                    eprintln!("failed to open settings: {e}");
                }
            }
            "always_on_top" => toggle_pref(app, |p| p.always_on_top = !p.always_on_top),
            "click_through" => toggle_pref(app, |p| p.click_through = !p.click_through),
            "autostart" => toggle_pref(app, |p| p.autostart = !p.autostart),
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if matches!(crate::updater::status(&app), UpdateStatus::Available { .. }) {
                        let _ = crate::updater::install(&app).await;
                    } else {
                        crate::updater::check(&app, true).await;
                    }
                });
            }
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if !platform::TRAY_LEFT_CLICK_TOGGLES {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::toggle_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Flip a pref from the tray, apply it, and tell the frontend so it persists the change.
fn toggle_pref(app: &AppHandle, f: impl FnOnce(&mut Prefs)) {
    let mut prefs = *app.state::<PrefsState>().0.lock().unwrap();
    f(&mut prefs);
    if let Err(e) = crate::apply_prefs(app, prefs) {
        eprintln!("failed to apply prefs: {e}");
    }
    let applied = *app.state::<PrefsState>().0.lock().unwrap();
    let _ = app.emit("tray-prefs-changed", applied);
}

/// Make the tray checkmarks reflect the current prefs.
pub fn sync_checks(app: &AppHandle, prefs: Prefs) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.always_on_top.set_checked(prefs.always_on_top);
        let _ = items.click_through.set_checked(prefs.click_through);
        let _ = items.autostart.set_checked(prefs.autostart);
    }
}

/// The update item doubles as a status line, so a check started from the tray reports back
/// even when no window is open.
fn update_label(status: &UpdateStatus) -> String {
    match status {
        UpdateStatus::Idle => "Check for updates…".into(),
        UpdateStatus::Checking => "Checking for updates…".into(),
        UpdateStatus::UpToDate => "Up to date — check again".into(),
        UpdateStatus::Available { version, .. } => format!("Install update v{version} and restart"),
        UpdateStatus::Downloading { percent: Some(p) } => format!("Downloading update… {p}%"),
        UpdateStatus::Downloading { percent: None } => "Downloading update…".into(),
        UpdateStatus::Installing => "Installing update…".into(),
        UpdateStatus::Error { .. } => "Update check failed — retry".into(),
    }
}

pub fn sync_update(app: &AppHandle, status: &UpdateStatus) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let busy = matches!(
            status,
            UpdateStatus::Checking | UpdateStatus::Downloading { .. } | UpdateStatus::Installing
        );
        let _ = items.update.set_text(update_label(status));
        let _ = items.update.set_enabled(!busy);
    }
}
