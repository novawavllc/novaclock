# NovaClock - World Clock Windows Desktop Widget

A lightweight desktop widget showing clocks for the time zones you choose. Built with **Tauri 2**
(Rust + system webview) and vanilla TypeScript. Windows is the first target. The code is laid out
so Linux and macOS builds need little extra work.

## Features

- 1–12 clocks in a responsive grid that wraps as you resize the window, or a fixed layout:
  one row, one column, or a table with a set number of clocks per row or per column
- Analog SVG face with a smooth second hand, digital time, or both
- 12h/24h and optional seconds
- Date line: off, only when the zone's date differs from yours, or always, in six formats
- Day/night tint per zone (06:00–18:00 counts as day)
- Optional time zone chips: UTC offset and offset relative to local time (`UTC+5:30`, `+13h`)
- Location, date and time zone can each sit below the clock or inside the analog dial
- Optional pinned local clock
- Searchable time zone picker (by city, country or offset), drag-to-reorder, custom labels
- Light / dark / system theme, S/M/L sizes, adjustable spacing between clocks
- Separate opacity controls for the clocks and the background, and the background can be turned off
- The window always wraps the clocks exactly. In Auto layout, drag it wider or narrower to change the number of
  columns, and it snaps to fit.
- Click-through mode: mouse clicks pass through the widget to whatever is behind it
- Frameless transparent window you drag from anywhere, hidden from the taskbar by default
- Tray menu: Show/Hide, Settings, Always on top, Click-through, Start with Windows, Quit
- Closing the window hides it to the tray. Position and size are remembered. Only one instance runs at a time.

## Requirements

- Node.js 20+ (22.6+ for `npm test`)
- Rust (stable) with the MSVC toolchain on Windows
- WebView2 (preinstalled on Windows 10/11; the installer bootstraps it if it is missing)

## Develop

```sh
npm install
npm run tauri dev     # run the widget with hot reload
npm test              # Intl/DST unit tests (Kolkata, Adelaide, Chatham, US/EU DST switches)
```

In debug builds, "Start with Windows" is saved but **not** registered with the OS, so your
machine doesn't end up auto-launching a dev binary. Release builds register it for real.

## Build the Windows installer

```sh
npm run tauri build
```

This writes an NSIS installer to `src-tauri/target/release/bundle/nsis/`. It installs per user
and downloads WebView2 only if the machine lacks it.

## Releases and auto-update

Installed copies update themselves from GitHub Releases
([novawavllc/novaclock](https://github.com/novawavllc/novaclock)) using Tauri's updater plugin:

- The app checks `releases/latest/download/latest.json` 30 s after launch and then every 6 hours
  (Settings → Updates → "Check for updates automatically"). You can also check from Settings or
  the tray menu.
- When an update is found, the tray item changes to "Install update vX and restart", Settings
  shows the release notes, and a dot appears on the widget's gear button. Nothing installs
  without a click.
- Every update is checked against the public key in `tauri.conf.json` before it installs, so only
  builds signed with the project's private key are accepted.

**One-time setup.** Add the signing key as a repository secret (Settings → Secrets and variables →
Actions → New repository secret):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of the private key file (`novaclock.key`) |

The key has no password. Don't create `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: GitHub doesn't allow
empty secrets, and when it's missing the workflow passes an empty string, which is what this key
needs.

Back up the private key somewhere safe. If you lose it, installed copies can never be updated
again, because they only trust that key.

**Cutting a release:**

```sh
# 1. bump "version" in package.json (the single source of the app version), commit
git tag v0.2.0
git push origin main v0.2.0
```

The `Release` workflow builds and signs the installer and creates a **draft** release with the
installer, its `.sig` and `latest.json`. Review it, then click **Publish**. Installed apps only
see published releases, so publishing is the moment the update rolls out.

## Project layout

```
src/
  main.ts       widget entry: grid rendering, tick loop, drag, tray sync
  clock.ts      clock component (analog SVG + digital readout)
  settings.ts   settings window UI
  store.ts      typed, versioned settings via tauri-plugin-store + cross-window sync
  tz.ts         pure Intl helpers (offsets, formatting): no DOM, unit-tested
  tzdata.ts     zone → country table for picker search
  styles.css    theming for both windows
src-tauri/src/
  main.rs       plugins, commands, window lifecycle
  tray.rs       tray icon + menu
  updater.rs    background update checks, download + install
  platform.rs   all OS-specific bits, isolated
```

### How it works

- **Time math.** All formatting goes through `Intl.DateTimeFormat` with IANA IDs. The UTC offset
  is parsed from `timeZoneName: 'shortOffset'`, and no offsets are hard-coded, so DST follows the
  OS/webview tz database.
- **Ticking.** A single timer re-aligns itself to the next second boundary on every tick. All
  clocks update from one `Date`, and the DOM is only touched when a value changes. The smooth
  second hand is a separate GPU-composited layer driven by `requestAnimationFrame`. It moves in
  15 steps per second (under 1 px per step even on the large face), so frames in between cost
  almost nothing. WebView2 doesn't fire `visibilitychange` when a window is hidden, so the Rust
  side emits `widget-visibility` on hide and show, and both loops pause while the widget is in
  the tray.

Measured on the release build (Windows 11, 4 clocks, analog + digital): idle CPU about 4% of one
core while visible, about 0.1% while hidden; 3.5 MB exe, 1.3 MB installer.
- **Settings.** Settings are stored as `{ "version": 2, ... }` in `settings.json` in the app config
  directory. `migrate()` in `store.ts` upgrades older files one version at a time; v1 → v2 turned
  the "always show date" flag into the three-way date mode. A migrated file is saved straight away. The
  settings window saves the file and emits `settings-changed`, and the widget applies the change
  live. Tray toggles go Rust → `tray-prefs-changed` → the widget persists them and rebroadcasts.

## Porting to Linux / macOS

All OS-specific code is in `src-tauri/src/platform.rs`: autostart label and mechanism, tray click
behaviour, macOS Dock hiding, and window shadow and taskbar flags. To build for another OS:

```sh
npm run tauri build -- --bundles appimage,deb   # Linux
npm run tauri build -- --bundles dmg            # macOS
```

Known per-OS caveats to check in that pass: skip-taskbar is ignored by some Wayland compositors,
and on Linux the tray needs `libayatana-appindicator`. macOS transparency is already enabled
through `macOSPrivateApi`, which means the app can't be submitted to the Mac App Store.
