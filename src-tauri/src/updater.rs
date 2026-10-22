//! Auto-update from GitHub Releases via tauri-plugin-updater.
//!
//! Lives on the Rust side so checks run (and the tray reflects them) even when no window
//! is open. Status changes are broadcast to the frontend as `update-status` events.

use std::{sync::Mutex, thread, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::PrefsState;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Default, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Available { version: String, notes: Option<String> },
    Downloading { percent: Option<u8> },
    Installing,
    Error { message: String },
}

#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    status: Mutex<UpdateStatus>,
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    app.state::<UpdaterState>().status.lock().unwrap().clone()
}

fn set_status(app: &AppHandle, status: UpdateStatus) {
    *app.state::<UpdaterState>().status.lock().unwrap() = status.clone();
    crate::tray::sync_update(app, &status);
    let _ = app.emit("update-status", status);
}

fn busy(app: &AppHandle) -> bool {
    matches!(
        status(app),
        UpdateStatus::Checking | UpdateStatus::Downloading { .. } | UpdateStatus::Installing
    )
}

/// Ask the release endpoint whether a newer version exists. Background (non-manual)
/// failures are logged but not surfaced, so being offline doesn't nag the user.
pub async fn check(app: &AppHandle, manual: bool) -> UpdateStatus {
    if busy(app) {
        return status(app);
    }
    let previous = status(app);
    set_status(app, UpdateStatus::Checking);

    let result = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };

    let next = match result {
        Ok(Some(update)) => {
            let next = UpdateStatus::Available { version: update.version.clone(), notes: update.body.clone() };
            *app.state::<UpdaterState>().pending.lock().unwrap() = Some(update);
            next
        }
        Ok(None) => UpdateStatus::UpToDate,
        Err(message) if manual => UpdateStatus::Error { message },
        Err(message) => {
            eprintln!("background update check failed: {message}");
            previous
        }
    };
    set_status(app, next.clone());
    next
}

/// Download, verify (signature), install, and restart into the new version.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let Some(update) = app.state::<UpdaterState>().pending.lock().unwrap().take() else {
        return Err("No update is available.".into());
    };

    set_status(app, UpdateStatus::Downloading { percent: None });
    let mut received: u64 = 0;
    let mut last_percent: Option<u8> = None;
    let progress_app = app.clone();
    let finish_app = app.clone();

    let result = update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let percent = total.filter(|t| *t > 0).map(|t| (received * 100 / t).min(100) as u8);
                if percent != last_percent {
                    last_percent = percent;
                    set_status(&progress_app, UpdateStatus::Downloading { percent });
                }
            },
            move || set_status(&finish_app, UpdateStatus::Installing),
        )
        .await;

    match result {
        // On Windows the installer has already taken over and the app exits on its own;
        // elsewhere, restart into the freshly installed version.
        Ok(()) => app.restart(),
        Err(e) => {
            let message = e.to_string();
            set_status(app, UpdateStatus::Error { message: message.clone() });
            Err(message)
        }
    }
}

/// Periodic background checks, gated on the "check automatically" preference.
pub fn spawn_background_checks(app: AppHandle) {
    // A dev build should never try to replace itself with a release.
    if cfg!(debug_assertions) {
        return;
    }
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK_DELAY);
        loop {
            let enabled = app.state::<PrefsState>().0.lock().unwrap().auto_update;
            let already_found = matches!(status(&app), UpdateStatus::Available { .. });
            if enabled && !already_found {
                tauri::async_runtime::block_on(check(&app, false));
            }
            thread::sleep(CHECK_INTERVAL);
        }
    });
}
