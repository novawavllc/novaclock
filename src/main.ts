// Widget window entry: builds the clock grid and runs the tick loop.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ClockView, type TickContext } from './clock.ts';
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

function render(): void {
  applyAppearance(settings);
  const local = localTimeZone();
  const models = settings.clocks.map((c) => ({ tz: c.tz, label: clockLabel(c), isLocal: false }));
  if (settings.showLocal) {
    models.unshift({ tz: local, label: settings.localLabel.trim() || `Local · ${cityFromTimeZone(local)}`, isLocal: true });
  }
  views = models.map((m) => new ClockView(m));
  grid.replaceChildren(...views.map((v) => v.root));
  if (views.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No clocks — right-click to open settings.';
    grid.append(empty);
  }
  restart();
  layout();
}

// --- Fit window to content ----------------------------------------------------
// The window is always sized to exactly wrap the clocks. The user picks the layout by
// resizing: the width they drag to decides the column count, then the window snaps to fit.

const shell = document.getElementById('widget')!;
let fitTarget: { w: number; h: number } | null = null;
let userResizeTimer: number | undefined;

const px = (v: string) => parseFloat(v) || 0;

function columnsFor(width: number): number {
  const gs = getComputedStyle(grid);
  const card = px(getComputedStyle(document.documentElement).getPropertyValue('--card-w'));
  const gap = px(gs.columnGap);
  const chrome = px(gs.paddingLeft) + px(gs.paddingRight) + 2; // + shell border
  const fit = Math.floor((width - chrome + gap) / (card + gap));
  return Math.max(1, Math.min(fit, Math.max(views.length, 1)));
}

/** Recompute columns from the current window width, then snap the window to the content. */
function layout(): void {
  grid.style.setProperty('--cols', String(columnsFor(window.innerWidth)));
  fit();
}

function fit(): void {
  const r = shell.getBoundingClientRect();
  const w = Math.ceil(r.width);
  const h = Math.ceil(r.height);
  if (Math.abs(w - window.innerWidth) <= 1 && Math.abs(h - window.innerHeight) <= 1) return;
  fitTarget = { w, h };
  void appWindow.setSize(new LogicalSize(w, h));
}

window.addEventListener('resize', () => {
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

function tick(): void {
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
  for (const v of views) v.tick(ctx);
}

function scheduleTick(): void {
  tickTimer = window.setTimeout(() => {
    tick();
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
  render();
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
    restart();
  });

  await onSettingsChanged('main', (s) => {
    settings = s;
    render();
  });

  await onTrayPrefsChanged(async (p) => {
    settings = { ...settings, ...p };
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
