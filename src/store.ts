// Typed settings load/save via tauri-plugin-store, plus cross-window sync.
import { load, type Store } from '@tauri-apps/plugin-store';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isValidTimeZone, cityFromTimeZone, DATE_FORMATS, type DateFormat } from './tz.ts';

export type DisplayMode = 'analog' | 'digital' | 'both';
export type ClockSize = 's' | 'm' | 'l';
export type Theme = 'light' | 'dark' | 'system';
/** 'auto' = columns follow the window width the user drags to. */
export type Layout = 'auto' | 'horizontal' | 'vertical' | 'table';
/** Table fill order: rows first (count = clocks per row) or columns first (count = clocks per column). */
export type TableFill = 'rows' | 'columns';
/** 'auto' = only when the zone's date differs from the local date. */
export type DateMode = 'off' | 'auto' | 'always';

export interface ClockEntry {
  id: string;
  tz: string;
  /** Empty string = derive from the IANA ID. */
  label: string;
}

export interface Settings {
  version: 2;
  showLocal: boolean;
  localLabel: string;
  clocks: ClockEntry[];
  hour12: boolean;
  showSeconds: boolean;
  dateMode: DateMode;
  dateFormat: DateFormat;
  /** UTC-offset and relative-to-local chips. */
  showTimeZone: boolean;
  /** Draw the date and time zone inside the analog dial instead of below the clock. */
  infoInDial: boolean;
  /** Draw the location label inside the analog dial instead of below it. */
  labelInDial: boolean;
  displayMode: DisplayMode;
  layout: Layout;
  tableFill: TableFill;
  /** Clocks per row (or per column, when filling by columns) in table layout. */
  tablePerLine: number;
  /** Gap between clocks in px, 0–40. */
  spacing: number;
  size: ClockSize;
  theme: Theme;
  showBackground: boolean;
  /** Widget background opacity, 0.5–1. */
  opacity: number;
  /** Opacity of the clocks themselves, 0.2–1. */
  clockOpacity: number;
  alwaysOnTop: boolean;
  /** Mouse clicks pass through the widget to whatever is behind it. */
  clickThrough: boolean;
  autostart: boolean;
  /** Check GitHub Releases for new versions in the background. */
  autoUpdate: boolean;
}

export const SCHEMA_VERSION = 2;
export const MAX_CLOCKS = 12;
const STORE_FILE = 'settings.json';
const KEY = 'settings';
const SYNC_EVENT = 'settings-changed';

export type WindowSource = 'main' | 'settings';

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defaultSettings(): Settings {
  return {
    version: 2,
    showLocal: true,
    localLabel: '',
    clocks: ['America/New_York', 'Europe/London', 'Asia/Tokyo'].map((tz) => ({ id: newId(), tz, label: '' })),
    hour12: false,
    showSeconds: true,
    dateMode: 'auto',
    dateFormat: 'short',
    showTimeZone: true,
    infoInDial: false,
    labelInDial: false,
    displayMode: 'both',
    layout: 'auto',
    tableFill: 'rows',
    tablePerLine: 3,
    spacing: 6,
    size: 'm',
    theme: 'dark',
    showBackground: true,
    opacity: 0.9,
    clockOpacity: 1,
    alwaysOnTop: false,
    clickThrough: false,
    autostart: false,
    autoUpdate: true,
  };
}

export function maxExtraClocks(s: Pick<Settings, 'showLocal'>): number {
  return MAX_CLOCKS - (s.showLocal ? 1 : 0);
}

export function clockLabel(entry: ClockEntry): string {
  return entry.label.trim() || cityFromTimeZone(entry.tz);
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const range = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Upgrade older schemas in place, one version at a time. */
function migrate(r: Record<string, unknown>): void {
  if (r.version === undefined || r.version === 1) {
    // v1 had a single "always show date" flag; otherwise the date showed only when it differed.
    r.dateMode = r.showDate === true ? 'always' : 'auto';
    delete r.showDate;
    r.version = 2;
  }
}

/** Validate and fill in anything missing. */
export function normalize(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = { ...(raw as Record<string, unknown>) };
  migrate(r);

  const s: Settings = {
    version: 2,
    showLocal: bool(r.showLocal, d.showLocal),
    localLabel: typeof r.localLabel === 'string' ? r.localLabel : '',
    clocks: [],
    hour12: bool(r.hour12, d.hour12),
    showSeconds: bool(r.showSeconds, d.showSeconds),
    dateMode: pick(r.dateMode, ['off', 'auto', 'always'], d.dateMode),
    dateFormat: pick(r.dateFormat, DATE_FORMATS, d.dateFormat),
    showTimeZone: bool(r.showTimeZone, d.showTimeZone),
    infoInDial: bool(r.infoInDial, d.infoInDial),
    labelInDial: bool(r.labelInDial, d.labelInDial),
    displayMode: pick(r.displayMode, ['analog', 'digital', 'both'], d.displayMode),
    layout: pick(r.layout, ['auto', 'horizontal', 'vertical', 'table'], d.layout),
    tableFill: pick(r.tableFill, ['rows', 'columns'], d.tableFill),
    tablePerLine: Math.round(range(r.tablePerLine, 1, MAX_CLOCKS, d.tablePerLine)),
    spacing: Math.round(range(r.spacing, 0, 40, d.spacing)),
    size: pick(r.size, ['s', 'm', 'l'], d.size),
    theme: pick(r.theme, ['light', 'dark', 'system'], d.theme),
    showBackground: bool(r.showBackground, d.showBackground),
    opacity: range(r.opacity, 0.5, 1, d.opacity),
    clockOpacity: range(r.clockOpacity, 0.2, 1, d.clockOpacity),
    alwaysOnTop: bool(r.alwaysOnTop, d.alwaysOnTop),
    clickThrough: bool(r.clickThrough, d.clickThrough),
    autostart: bool(r.autostart, d.autostart),
    autoUpdate: bool(r.autoUpdate, d.autoUpdate),
  };
  if (Array.isArray(r.clocks)) {
    for (const c of r.clocks) {
      if (!c || typeof c !== 'object' || !isValidTimeZone((c as ClockEntry).tz)) continue;
      const e = c as Partial<ClockEntry>;
      s.clocks.push({
        id: typeof e.id === 'string' && e.id ? e.id : newId(),
        tz: e.tz!,
        label: typeof e.label === 'string' ? e.label : '',
      });
    }
  } else {
    s.clocks = d.clocks;
  }
  s.clocks = s.clocks.slice(0, maxExtraClocks(s));
  return s;
}

let storePromise: Promise<Store> | undefined;
function store(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { defaults: {}, autoSave: false });
  return storePromise;
}

/** Returns persisted settings, or first-run defaults. Defaults and migrations are saved immediately. */
export async function loadSettings(): Promise<Settings> {
  const st = await store();
  const raw = await st.get<{ version?: unknown }>(KEY);
  const s = normalize(raw);
  if (raw?.version !== SCHEMA_VERSION) await saveSettings(s);
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  const st = await store();
  await st.set(KEY, s);
  await st.save();
}

interface SyncPayload {
  source: WindowSource;
  settings: Settings;
}

/** Tell the other window(s) that settings changed. */
export function broadcast(source: WindowSource, settings: Settings): Promise<void> {
  return emit(SYNC_EVENT, { source, settings } satisfies SyncPayload);
}

export function onSettingsChanged(self: WindowSource, cb: (s: Settings) => void): Promise<UnlistenFn> {
  return listen<SyncPayload>(SYNC_EVENT, (e) => {
    if (e.payload.source !== self) cb(normalize(e.payload.settings));
  });
}

export interface NativePrefs {
  alwaysOnTop: boolean;
  clickThrough: boolean;
  autostart: boolean;
  autoUpdate: boolean;
}

/** Push window-level prefs to the Rust side (also syncs tray checkmarks). */
export function applyNativePrefs(s: NativePrefs): Promise<void> {
  return invoke('apply_window_prefs', {
    alwaysOnTop: s.alwaysOnTop,
    clickThrough: s.clickThrough,
    autostart: s.autostart,
    autoUpdate: s.autoUpdate,
  });
}

/** Fired by the tray menu when the user toggles a checkbox there. */
export function onTrayPrefsChanged(cb: (p: NativePrefs) => void): Promise<UnlistenFn> {
  return listen<NativePrefs>('tray-prefs-changed', (e) => cb(e.payload));
}

/** Apply theme/opacity/size to the document root (shared by both windows). */
export function applyAppearance(s: Settings, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = s.theme;
  root.dataset.size = s.size;
  root.dataset.mode = s.displayMode;
  root.style.setProperty('--bg-alpha', String(s.opacity));
  root.style.setProperty('--clock-alpha', String(s.clockOpacity));
  root.style.setProperty('--clock-gap', `${s.spacing}px`);
  root.classList.toggle('no-seconds', !s.showSeconds);
  root.classList.toggle('no-bg', !s.showBackground);
  root.classList.toggle('no-tz', !s.showTimeZone);
}

// --- Updates ------------------------------------------------------------------

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'upToDate' | 'installing' }
  | { state: 'available'; version: string; notes: string | null }
  | { state: 'downloading'; percent: number | null }
  | { state: 'error'; message: string };

export const getUpdateStatus = () => invoke<UpdateStatus>('update_status');
export const checkForUpdates = () => invoke<UpdateStatus>('check_for_updates');
export const installUpdate = () => invoke<void>('install_update');

export function onUpdateStatus(cb: (s: UpdateStatus) => void): Promise<UnlistenFn> {
  return listen<UpdateStatus>('update-status', (e) => cb(e.payload));
}
