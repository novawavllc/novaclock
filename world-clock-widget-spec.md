# World Clock Desktop Widget — Build Specification

## Goal

A lightweight desktop widget that displays multiple clocks for user-selected time zones. Ships for **Windows first**; the architecture must make **Linux and macOS ports trivial later**.

## Tech Stack (decided — do not change without asking)

- **Tauri 2** (Rust backend + webview frontend). Chosen over Electron for small binary size (~5–10 MB), low RAM use, and first-class Windows/Linux/macOS support from one codebase. Chosen over a native Windows 11 Widgets Board widget because Widgets Board requires MSIX packaging, is Adaptive-Card-based (no smooth live clock rendering), and has no Linux/macOS path.
- **Frontend:** Vanilla TypeScript + Vite (no React/Vue — the UI is small; keep it dependency-light). CSS for theming.
- **Time zone logic:** Browser-native `Intl.DateTimeFormat` with IANA time zone IDs (e.g. `America/New_York`, `Asia/Tokyo`). No moment/luxon/dayjs dependency needed — `Intl` handles DST correctly and the tz database updates with the OS/webview.
- **Settings persistence:** `tauri-plugin-store` (JSON file in app config dir).
- **Autostart:** `tauri-plugin-autostart`.
- **Tray:** Tauri's built-in tray icon API.

## Widget Behavior (Windows)

- Frameless, transparent-background window (`decorations: false`, `transparent: true`).
- **Always-on-desktop mode by default** (skip taskbar, no always-on-top), with a toggle for **always-on-top mode**.
- Draggable by clicking anywhere on the widget body (use Tauri `startDragging`).
- Window position and size are remembered across restarts.
- Tray icon with menu: Show/Hide widget, Settings, Always on top (checkbox), Start with Windows (checkbox), Quit.
- Closing the window hides it to tray instead of quitting.

## Features

### Clocks
1. Display **1–12 clocks** in a responsive grid (auto-wraps; user can resize the window).
2. Each clock shows:
   - City label (user-editable, defaults to city from the IANA ID)
   - **Analog clock face** (SVG, smooth-ticking second hand) **and/or digital time** — per-widget display mode setting: `analog`, `digital`, or `both`.
   - Digital time with seconds, 12h/24h toggle (global setting).
   - Date line (e.g. `Wed, Oct 21`) — shown when the date differs from local, always-on optional.
   - Day/night indicator: clock face tints light during local daytime (6:00–18:00 as a simple default) and dark at night.
   - UTC offset chip (e.g. `UTC−4`) and a relative-to-local chip (e.g. `+13h`).
3. Local time zone is always available as an optional pinned first clock.

### Settings panel
Opens as a separate small Tauri window (or an overlay panel — implementer's choice, but it must work on all three OSes):
- Add/remove/reorder time zones (drag to reorder).
- Time zone picker: searchable list built from `Intl.supportedValuesOf('timeZone')`, searchable by city name and country.
- 12h/24h format, show seconds on/off, show date on/off.
- Display mode (analog/digital/both), clock size (S/M/L).
- Theme: light / dark / follow system (`prefers-color-scheme`).
- Opacity slider for the widget background (50–100%).
- Always on top, start with OS.

### Defaults on first run
Local time zone + `America/New_York`, `Europe/London`, `Asia/Tokyo`. Dark theme, 24h, analog+digital, medium size.

## Implementation Notes

- **Ticking:** one `setInterval` aligned to the next second boundary (compute `1000 - Date.now() % 1000` drift correction each tick); update all clocks from a single `Date`. For the smooth analog second hand, use `requestAnimationFrame` only while the window is visible; pause rendering when hidden (listen to `visibilitychange`) to keep CPU near zero.
- **DST correctness:** never store or compute offsets manually. Always format via `Intl.DateTimeFormat(locale, { timeZone })`. Derive the UTC offset chip with `formatToParts` and `timeZoneName: 'shortOffset'`.
- **Settings schema** (persisted JSON): version the schema (`"version": 1`) so future migrations are possible.
- **Cross-platform discipline:** no `#[cfg(windows)]`-only logic in core features. Platform-specific code (autostart path, tray quirks, transparency flags) isolated in one Rust module. CSS must not rely on Windows-only fonts — use a font stack (`system-ui` first).
- **Single instance:** use `tauri-plugin-single-instance`; launching a second copy focuses the existing widget.

## Project Structure

```
world-clock-widget/
├── src/                 # frontend (TS + CSS)
│   ├── main.ts          # entry, tick loop
│   ├── clock.ts         # clock component (analog SVG + digital)
│   ├── settings.ts      # settings UI
│   ├── store.ts         # typed settings load/save via plugin-store
│   └── styles.css
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── tray.rs
│   │   └── platform.rs  # OS-specific bits, isolated
│   ├── tauri.conf.json
│   └── Cargo.toml
├── package.json
└── README.md
```

## Milestones (build in this order)

1. **Scaffold:** Tauri 2 + Vite TS app; frameless transparent draggable window renders one hardcoded digital clock.
2. **Multi-clock core:** clock grid, tick loop, `Intl`-based formatting, analog SVG face, day/night tint, offset chips.
3. **Settings:** persistence, time zone picker, add/remove/reorder, format/theme/size options, first-run defaults.
4. **Windows polish:** tray icon + menu, hide-to-tray, always-on-top toggle, autostart, single instance, remember position.
5. **Packaging:** Windows installer via `tauri build` (NSIS). Verify binary size and idle CPU (<1%) / RAM (<100 MB).
6. **(Later, separate pass):** Linux (AppImage/deb) and macOS (dmg) builds — expected to mostly "just work"; fix tray/transparency quirks per OS.

## Acceptance Criteria

- Clocks are correct across DST boundaries and for half-hour zones (test `Asia/Kolkata`, `Australia/Adelaide`, `Pacific/Chatham`).
- Idle CPU <1% with window visible; ~0% when hidden.
- Settings survive restart; window reopens at last position.
- Quitting from tray fully exits; closing the window only hides it.
- Works on a clean Windows 10/11 machine with no runtime prerequisites beyond WebView2 (bundled/bootstrapped by the installer).

## Out of Scope (v1)

World map view, alarms/timers, meeting-time planner, weather, Windows Widgets Board integration.
