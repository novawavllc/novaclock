// Docking: pins the widget to an edge of its screen and, with auto-hide, slides it out of
// view until the pointer hovers the "World Clock" tab left on that edge.
//
// Hiding shrinks the window to a small labelled tab on the edge rather than moving it off-screen,
// because off-screen on one monitor can be on-screen on the next one over.
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from '@tauri-apps/api/window';
import type { DockEdge } from './store.ts';

const appWindow = getCurrentWindow();
const root = document.documentElement;

/** Logical size of the "World Clock" tab left on screen while hidden (matches .dock-handle). */
const TAB_LEN = 92;
const TAB_THICK = 20;
/** How long the pointer must stay away before the widget hides. */
const HIDE_DELAY = 700;
const POLL_MS = 120;
/** Matches the slide transition in styles.css. */
const SLIDE_MS = 180;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let edge: DockEdge | null = null;
let autoHide = false;
let clickThrough = false;
let paused = false;
let monitor: Monitor | null = null;
/** Logical size of the widget content, from the last place() call. */
let content: { w: number; h: number } | null = null;
let hidden = false;
/** Where the window actually is (physical px), kept current from move/resize events. */
let win: Rect = { x: 0, y: 0, w: 0, h: 0 };
/** Where we last put it, to tell our own moves apart from the user dragging it. */
let placed: Rect | null = null;
let pollTimer: number | undefined;
let awaySince = 0;
let snapTimer: number | undefined;
let slideTimer: number | undefined;

const near = (a: number, b: number) => Math.abs(a - b) <= 2;
const inside = (x: number, y: number, r: Rect, pad = 0) =>
  x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;

export const dockEdge = (): DockEdge | null => edge;

/** The docked screen's work area (excluding the taskbar) in logical px, for laying out the clocks. */
export function dockArea(): { w: number; h: number } | null {
  if (!monitor) return null;
  const { size } = monitor.workArea;
  return { w: size.width / monitor.scaleFactor, h: size.height / monitor.scaleFactor };
}

/** Apply the dock settings. Resolves once the screen to dock on is known. */
export async function configureDock(next: DockEdge | null, hide: boolean, passThrough: boolean): Promise<void> {
  const wasDocked = edge !== null;
  edge = next;
  autoHide = hide && next !== null;
  clickThrough = passThrough;

  if (next) root.dataset.dock = next;
  else delete root.dataset.dock;
  if (hidden && !autoHide) reveal();
  if (!next) {
    stopPolling();
    placed = null;
    if (wasDocked) await appWindow.setResizable(true);
    return;
  }
  // The dock decides the size, so edge-dragging would just snap back.
  if (!wasDocked) await appWindow.setResizable(false);
  monitor = (await currentMonitor()) ?? monitor;
  syncPolling();
}

/** Stop watching the pointer while the whole widget is hidden to the tray. */
export function pauseDock(p: boolean): void {
  paused = p;
  syncPolling();
}

/** Size and position the window for content of `w`×`h` logical px. */
export function place(w: number, h: number): void {
  content = { w, h };
  void applyPlacement();
}

/** Where the widget sits when shown, in physical px. */
function shownRect(): Rect | null {
  if (!edge || !monitor || !content) return null;
  const scale = monitor.scaleFactor;
  const { position: wp, size: ws } = monitor.workArea;
  const area = { x: wp.x, y: wp.y, w: ws.width, h: ws.height };
  const w = Math.round(content.w * scale);
  const h = Math.round(content.h * scale);
  // Centred along the edge, but never starting off-screen if it's longer than the edge.
  const x = area.x + Math.max(0, Math.round((area.w - w) / 2));
  const y = area.y + Math.max(0, Math.round((area.h - h) / 2));
  switch (edge) {
    case 'top':
      return { x, y: area.y, w, h };
    case 'bottom':
      return { x, y: area.y + area.h - h, w, h };
    case 'left':
      return { x: area.x, y, w, h };
    case 'right':
      return { x: area.x + area.w - w, y, w, h };
  }
}

function target(): Rect | null {
  const r = shownRect();
  if (!r || !hidden || !monitor) return r;
  // Hidden: just the tab, centred where the widget was.
  const len = Math.min(Math.round(TAB_LEN * monitor.scaleFactor), edge === 'top' || edge === 'bottom' ? r.w : r.h);
  const thick = Math.round(TAB_THICK * monitor.scaleFactor);
  const cx = r.x + Math.round((r.w - len) / 2);
  const cy = r.y + Math.round((r.h - len) / 2);
  switch (edge) {
    case 'top':
      return { x: cx, y: r.y, w: len, h: thick };
    case 'bottom':
      return { x: cx, y: r.y + r.h - thick, w: len, h: thick };
    case 'left':
      return { x: r.x, y: cy, w: thick, h: len };
    default:
      return { x: r.x + r.w - thick, y: cy, w: thick, h: len };
  }
}

async function applyPlacement(): Promise<void> {
  const t = target();
  if (!t) return;
  if (placed && near(placed.x, t.x) && near(placed.y, t.y) && near(placed.w, t.w) && near(placed.h, t.h)) return;
  const growing = !placed || t.w * t.h > placed.w * placed.h;
  placed = t;
  win = { ...t };
  const pos = () => appWindow.setPosition(new PhysicalPosition(t.x, t.y));
  const size = () => appWindow.setSize(new PhysicalSize(t.w, t.h));
  // Order so the window never pokes past the edge (and onto a neighbouring screen) in between.
  if (growing) {
    await pos();
    await size();
  } else {
    await size();
    await pos();
  }
}

// --- Auto-hide --------------------------------------------------------------

function hide(): void {
  if (hidden) return;
  hidden = true;
  root.classList.add('dock-hidden');
  // The tab is only a hint: the pointer is tracked by polling, so clicks can pass through it.
  void appWindow.setIgnoreCursorEvents(true);
  clearTimeout(slideTimer);
  slideTimer = window.setTimeout(() => void applyPlacement(), SLIDE_MS);
}

function reveal(): void {
  if (!hidden) return;
  hidden = false;
  clearTimeout(slideTimer);
  // Grow the window first, then slide the clocks into it.
  void applyPlacement().then(() => {
    void appWindow.setIgnoreCursorEvents(clickThrough);
    requestAnimationFrame(() => root.classList.remove('dock-hidden'));
  });
}

async function poll(): Promise<void> {
  pollTimer = undefined;
  try {
    const c = await cursorPosition();
    if (hidden) {
      // While hidden the window *is* the tab, so only hovering it brings the widget back.
      if (inside(c.x, c.y, win, 1)) reveal();
    } else if (inside(c.x, c.y, win, 4)) {
      awaySince = 0;
    } else if (!awaySince) {
      awaySince = Date.now();
    } else if (Date.now() - awaySince >= HIDE_DELAY) {
      awaySince = 0;
      hide();
    }
  } catch (err) {
    console.error('dock poll failed', err);
  }
  syncPolling();
}

function syncPolling(): void {
  if (autoHide && !paused) {
    pollTimer ??= window.setTimeout(() => void poll(), POLL_MS);
  } else {
    stopPolling();
  }
}

function stopPolling(): void {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  awaySince = 0;
}

// --- Dragging to another screen ---------------------------------------------
// The widget can still be dragged while docked; once it's dropped it snaps back to the same
// edge of whichever screen it ended up on.

void appWindow.onMoved(({ payload }) => {
  win.x = payload.x;
  win.y = payload.y;
  if (!edge || !placed || (near(payload.x, placed.x) && near(payload.y, placed.y))) return;
  clearTimeout(snapTimer);
  snapTimer = window.setTimeout(async () => {
    monitor = (await currentMonitor()) ?? monitor;
    placed = null;
    await applyPlacement();
  }, 400);
});

void appWindow.onResized(({ payload }) => {
  win.w = payload.width;
  win.h = payload.height;
});
