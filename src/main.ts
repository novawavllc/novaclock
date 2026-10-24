// Widget window entry: builds the clock grid and runs the tick loop.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ClockView, type TickContext } from './clock.ts';
import { configureDock, dockArea, dockEdge, pauseDock, place } from './dock.ts';
import {
  applyAppearance,
  applyNativePrefs,
  broadcast,
  clockLabel,
  loadSettings,
  onSettingsChanged,
  onTrayPrefsChanged,
  saveSettings,
  getUpdateStatus,
  onUpdateStatus,
  type Settings,
  type UpdateStatus,
} from './store.ts';
import { dayKey, localTimeZone, offsetMinutes, zonedTime, cityFromTimeZone } from './tz.ts';

const appWindow = getCurrentWindow();
const grid = document.getElementById('clocks')!;

let settings: Settings;
let views: ClockView[] = [];
let tickTimer: number | undefined;
let rafId = 0;
/** Tracked separately from document.visibilityState, which WebView2 doesn't update on hide. */
let windowShown = true;

async function render(): Promise<void> {
  applyAppearance(settings);
  const local = localTimeZone();
  const models = settings.clocks.map((c) => ({ tz: c.tz, label: clockLabel(c), isLocal: false }));
  if (settings.showLocal) {
    models.unshift({ tz: local, label: settings.localLabel.trim() || `Local · ${cityFromTimeZone(local)}`, isLocal: true });
  }
  // The dial only exists in analog/both mode; in digital mode everything stays below the time.
  const hasDial = settings.displayMode !== 'digital';
  const inDial = { info: settings.infoInDial && hasDial, label: settings.labelInDial && hasDial };
  views = models.map((m) => new ClockView(m, inDial));
  grid.replaceChildren(...views.map((v) => v.root));
  if (views.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No clocks — right-click to open settings.';
    grid.append(empty);
  }
  restart();
  layout();
  // Docking needs to know the screen first, so it lays out again once that's resolved.
  await applyDock();
  layout();
}

function applyDock(): Promise<void> {
  return configureDock(settings.dock === 'off' ? null : settings.dock, settings.dockAutoHide, settings.clickThrough);
}

// --- Fit window to content ----------------------------------------------------
// The window is always sized to exactly wrap the clocks. In 'auto' layout the user picks the
// column count by resizing: the width they drag to decides it, then the window snaps to fit.
// The other layouts fix the shape, so a drag just snaps back. Docked, the edge decides the shape.

const shell = document.getElementById('widget')!;
let fitTarget: { w: number; h: number } | null = null;
let userResizeTimer: number | undefined;

const px = (v: string) => parseFloat(v) || 0;

/**
 * Columns are as wide as the widest clock's content (capped at the size's --card-w), so a
 * dial with nothing wider below it isn't padded out with empty space.
 */
function measureColumns(): void {
  grid.classList.add('measuring');
  const w = Math.max(0, ...views.map((v) => v.root.getBoundingClientRect().width));
  grid.classList.remove('measuring');
  if (w > 0) grid.style.setProperty('--col-w', `${Math.ceil(w)}px`);
  else grid.style.removeProperty('--col-w');
}

/** How many items of `item` px fit in `space` px with `gap` between them. */
const countFitting = (space: number, item: number, gap: number) => Math.floor((space + gap) / (item + gap));

function columnsFor(width: number): number {
  const gs = getComputedStyle(grid);
  const col =
    px(grid.style.getPropertyValue('--col-w')) || px(getComputedStyle(document.documentElement).getPropertyValue('--card-w'));
  const chrome = px(gs.paddingLeft) + px(gs.paddingRight) + 2; // + shell border
  const fit = countFitting(width - chrome, col, px(gs.columnGap));
  return Math.max(1, Math.min(fit, Math.max(views.length, 1)));
}

/** Docked: one row along the top/bottom edge, one column along the sides, wrapping only if the screen is too small. */
function dockShape(n: number): { cols: number; rows?: number } {
  const area = dockArea();
  const edge = dockEdge();
  if (edge === 'top' || edge === 'bottom') return { cols: area ? columnsFor(area.w) : n };
  if (!area) return { cols: 1 };
  const gs = getComputedStyle(grid);
  const cardH = Math.max(1, ...views.map((v) => v.root.getBoundingClientRect().height));
  const chrome = px(gs.paddingTop) + px(gs.paddingBottom) + 2;
  const perCol = Math.max(1, countFitting(area.h - chrome, cardH, px(gs.rowGap)));
  return perCol >= n ? { cols: 1 } : { cols: Math.ceil(n / perCol), rows: perCol };
}

/** Grid shape for the chosen layout. `rows` is set only when the grid fills column by column. */
function gridShape(): { cols: number; rows?: number } {
  const n = Math.max(views.length, 1);
  if (dockEdge()) return dockShape(n);
  switch (settings.layout) {
    case 'horizontal':
      return { cols: n };
    case 'vertical':
      return { cols: 1 };
    case 'table': {
      const per = Math.min(settings.tablePerLine, n);
      if (settings.tableFill === 'rows') return { cols: per };
      return { cols: Math.ceil(n / per), rows: per };
    }
    default:
      return { cols: columnsFor(window.innerWidth) };
  }
}

/** Recompute the grid shape (from the current window width in 'auto'), then snap the window to the content. */
function layout(): void {
  measureColumns();
  const { cols, rows } = gridShape();
  grid.style.setProperty('--cols', String(cols));
  grid.classList.toggle('flow-column', rows !== undefined);
  if (rows !== undefined) grid.style.setProperty('--rows', String(rows));
  fit();
}

function fit(): void {
  const r = shell.getBoundingClientRect();
  const w = Math.ceil(r.width);
  const h = Math.ceil(r.height);
  if (dockEdge()) return place(w, h);
  if (Math.abs(w - window.innerWidth) <= 1 && Math.abs(h - window.innerHeight) <= 1) return;
  fitTarget = { w, h };
  void appWindow.setSize(new LogicalSize(w, h));
}

window.addEventListener('resize', () => {
  // Docked, dock.ts sizes and places the window (including shrinking it to a strip when hidden).
  if (dockEdge()) return;
  // Ignore the resize we caused ourselves.
  if (fitTarget && Math.abs(window.innerWidth - fitTarget.w) <= 2 && Math.abs(window.innerHeight - fitTarget.h) <= 2) {
    return;
  }
  fitTarget = null;
  // The user is dragging an edge: wait until they stop, then re-flow and snap.
  clearTimeout(userResizeTimer);
  userResizeTimer = window.setTimeout(() => {
    userResizeTimer = undefined;
    layout();
  }, 350);
});

// Content can change height on its own (e.g. a date line appears at midnight).
new ResizeObserver(() => {
  if (userResizeTimer === undefined) fit();
}).observe(shell);

// --- Tick loop ------------------------------------------------------------
// One timer re-aligned to the next second boundary every tick (drift-corrected),
// and an rAF loop for the smooth second hand only while it is actually visible.

/** Returns true if text that can change a clock's width (date, zone chips) changed. */
function tick(): boolean {
  const now = new Date();
  const local = localTimeZone();
  const ctx: TickContext = {
    now,
    localOffset: offsetMinutes(local, now),
    localDay: dayKey(zonedTime(local, now)),
    hour12: settings.hour12,
    dateMode: settings.dateMode,
    dateFormat: settings.dateFormat,
  };
  let resized = false;
  for (const v of views) resized = v.tick(ctx) || resized;
  return resized;
}

function scheduleTick(): void {
  tickTimer = window.setTimeout(() => {
    // E.g. a date line appearing at midnight may be wider than the current columns.
    if (tick()) layout();
    scheduleTick();
  }, 1000 - (Date.now() % 1000));
}

function needsSmoothHand(): boolean {
  return settings.displayMode !== 'digital' && settings.showSeconds && views.length > 0;
}

// 15 steps/s moves the hand <1px per step even on the large face, so it still reads as
// smooth, while frames in between write nothing and cost (almost) no paint/composite.
const HAND_STEPS_PER_SEC = 15;
let lastStep = -1;

function frame(): void {
  const step = Math.floor((Date.now() * HAND_STEPS_PER_SEC) / 1000);
  if (step !== lastStep) {
    lastStep = step;
    const angle = (((step / HAND_STEPS_PER_SEC) % 60) * 6).toFixed(2);
    for (const v of views) v.setSecondAngle(angle);
  }
  rafId = requestAnimationFrame(frame);
}

function stop(): void {
  clearTimeout(tickTimer);
  cancelAnimationFrame(rafId);
  tickTimer = undefined;
  rafId = 0;
}

function restart(): void {
  stop();
  if (!windowShown || document.visibilityState !== 'visible') return;
  tick();
  scheduleTick();
  lastStep = -1;
  if (needsSmoothHand()) frame();
}

document.addEventListener('visibilitychange', restart);

// --- Interaction ------------------------------------------------------------

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if ((e.target as Element).closest('button, input, a')) return;
  void appWindow.startDragging();
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  void invoke('open_settings');
});

document.getElementById('btn-settings')!.addEventListener('click', () => void invoke('open_settings'));
document.getElementById('btn-hide')!.addEventListener('click', () => void invoke('hide_widget'));

// Keep "follow system" theme live.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(settings));

// --- Boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  settings = await loadSettings();
  await render();
  await appWindow.show();

  const settingsBtn = document.getElementById('btn-settings')!;
  const showUpdateBadge = (s: UpdateStatus) => {
    const ready = s.state === 'available';
    settingsBtn.classList.toggle('has-update', ready);
    settingsBtn.title = ready ? `Settings — version ${s.version} is available` : 'Settings';
  };
  showUpdateBadge(await getUpdateStatus());
  await onUpdateStatus(showUpdateBadge);

  await listen<boolean>('widget-visibility', (e) => {
    windowShown = e.payload;
    pauseDock(!windowShown);
    restart();
  });

  await onSettingsChanged('main', (s) => {
    settings = s;
    void render();
  });

  await onTrayPrefsChanged(async (p) => {
    settings = { ...settings, ...p };
    void applyDock();
    await saveSettings(settings);
    await broadcast('main', settings);
  });

  try {
    await applyNativePrefs(settings);
  } catch (err) {
    console.error('apply_window_prefs failed', err);
  }
}

boot().catch((err) => {
  console.error(err);
  void appWindow.show();
});
