// Settings window: edits settings, persists them, and broadcasts to the widget.
import { invoke } from '@tauri-apps/api/core';
import {
  applyAppearance,
  applyNativePrefs,
  broadcast,
  loadSettings,
  maxExtraClocks,
  newId,
  onSettingsChanged,
  saveSettings,
  MAX_CLOCKS,
  checkForUpdates,
  getUpdateStatus,
  installUpdate,
  onUpdateStatus,
  type Settings,
  type UpdateStatus,
} from './store.ts';
import { getVersion } from '@tauri-apps/api/app';
import {
  canonicalId,
  cityFromTimeZone,
  formatDate,
  formatUtcOffset,
  localTimeZone,
  offsetMinutes,
  DATE_FORMATS,
} from './tz.ts';
import { countryText } from './tzdata.ts';

const form = document.getElementById('settings-form') as HTMLFormElement;
const list = document.getElementById('clock-list') as HTMLUListElement;
const search = document.getElementById('tz-search') as HTMLInputElement;
const results = document.getElementById('tz-results') as HTMLUListElement;
const countEl = document.getElementById('clock-count')!;
const opacityOut = document.getElementById('opacity-out')!;
const clockOpacityOut = document.getElementById('clock-opacity-out')!;
const spacingOut = document.getElementById('spacing-out')!;
const dateFormatSelect = document.getElementById('date-format') as HTMLSelectElement;

let settings: Settings;

const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement | RadioNodeList;

// --- Persist + sync -------------------------------------------------------

let saveTimer: number | undefined;

/** Apply locally, notify the widget immediately, persist shortly after. */
function commit(nativeChanged = false): void {
  applyAppearance(settings);
  void broadcast('settings', settings);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveSettings(settings), 250);
  if (nativeChanged) applyNativePrefs(settings).catch((e) => console.error(e));
  updateCount();
}

// Flush a pending save if the window is closed mid-debounce.
window.addEventListener('beforeunload', () => {
  if (saveTimer !== undefined) void saveSettings(settings);
});

// --- Simple fields --------------------------------------------------------

function populateForm(): void {
  (input('showLocal') as HTMLInputElement).checked = settings.showLocal;
  (input('localLabel') as HTMLInputElement).value = settings.localLabel;
  (input('hour12') as RadioNodeList).value = String(settings.hour12);
  (input('showSeconds') as HTMLInputElement).checked = settings.showSeconds;
  (input('showTimeZone') as HTMLInputElement).checked = settings.showTimeZone;
  (input('infoInDial') as HTMLInputElement).checked = settings.infoInDial;
  (input('labelInDial') as HTMLInputElement).checked = settings.labelInDial;
  (input('dateMode') as RadioNodeList).value = settings.dateMode;
  dateFormatSelect.value = settings.dateFormat;
  (input('displayMode') as RadioNodeList).value = settings.displayMode;
  (input('layout') as RadioNodeList).value = settings.layout;
  (input('tableFill') as RadioNodeList).value = settings.tableFill;
  (input('tablePerLine') as HTMLInputElement).value = String(settings.tablePerLine);
  (input('spacing') as HTMLInputElement).value = String(settings.spacing);
  spacingOut.textContent = `${settings.spacing}px`;
  (input('size') as RadioNodeList).value = settings.size;
  (input('theme') as RadioNodeList).value = settings.theme;
  (input('clockOpacity') as HTMLInputElement).value = String(Math.round(settings.clockOpacity * 100));
  clockOpacityOut.textContent = `${Math.round(settings.clockOpacity * 100)}%`;
  (input('showBackground') as HTMLInputElement).checked = settings.showBackground;
  (input('opacity') as HTMLInputElement).value = String(Math.round(settings.opacity * 100));
  opacityOut.textContent = `${Math.round(settings.opacity * 100)}%`;
  (input('alwaysOnTop') as HTMLInputElement).checked = settings.alwaysOnTop;
  (input('clickThrough') as HTMLInputElement).checked = settings.clickThrough;
  (input('dock') as RadioNodeList).value = settings.dock;
  (input('dockAutoHide') as HTMLInputElement).checked = settings.dockAutoHide;
  (input('autostart') as HTMLInputElement).checked = settings.autostart;
  (input('autoUpdate') as HTMLInputElement).checked = settings.autoUpdate;
  syncDependentFields();
}

/** Grey out controls that have no effect in the current state. */
function syncDependentFields(): void {
  document.getElementById('bg-opacity-field')!.classList.toggle('disabled', !settings.showBackground);
  dateFormatSelect.closest('.field')!.classList.toggle('disabled', settings.dateMode === 'off');
  document
    .getElementById('info-in-dial-row')!
    .classList.toggle('disabled', settings.displayMode === 'digital' || (settings.dateMode === 'off' && !settings.showTimeZone));
  const docked = settings.dock !== 'off';
  document.getElementById('layout-field')!.classList.toggle('disabled', docked);
  document.getElementById('table-fields')!.classList.toggle('disabled', docked || settings.layout !== 'table');
  document.getElementById('dock-auto-hide-row')!.classList.toggle('disabled', !docked);
  document.getElementById('dock-hint')!.hidden = !docked;
  document.getElementById('table-per-line-label')!.textContent =
    settings.tableFill === 'columns' ? 'Clocks per column' : 'Clocks per row';
  document.getElementById('label-in-dial-row')!.classList.toggle('disabled', settings.displayMode === 'digital');
  document.getElementById('click-through-hint')!.hidden = !settings.clickThrough;
}

/** Each option shows today's date in that format, so the choice is self-explanatory. */
function fillDateFormats(): void {
  const now = new Date();
  const tz = localTimeZone();
  dateFormatSelect.replaceChildren(
    ...DATE_FORMATS.map((f) => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = formatDate(tz, now, f);
      return o;
    }),
  );
}

form.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.name || t.closest('#clock-list') || t === search) return;
  switch (t.name) {
    case 'showLocal':
      settings.showLocal = t.checked;
      // Pinning local may push us over the limit; drop the overflow from the end.
      settings.clocks = settings.clocks.slice(0, maxExtraClocks(settings));
      renderList();
      break;
    case 'localLabel':
      settings.localLabel = t.value;
      break;
    case 'hour12':
      settings.hour12 = t.value === 'true';
      break;
    case 'showSeconds':
    case 'showTimeZone':
    case 'infoInDial':
    case 'labelInDial':
    case 'showBackground':
      settings[t.name] = t.checked;
      break;
    case 'dateMode':
      settings.dateMode = t.value as Settings['dateMode'];
      break;
    case 'dateFormat':
      settings.dateFormat = t.value as Settings['dateFormat'];
      break;
    case 'clockOpacity':
      settings.clockOpacity = Number(t.value) / 100;
      clockOpacityOut.textContent = `${t.value}%`;
      break;
    case 'displayMode':
      settings.displayMode = t.value as Settings['displayMode'];
      break;
    case 'layout':
      settings.layout = t.value as Settings['layout'];
      break;
    case 'tableFill':
      settings.tableFill = t.value as Settings['tableFill'];
      break;
    case 'tablePerLine': {
      const n = Math.round(Number(t.value));
      // Ignore the transient empty/out-of-range values while the user is typing.
      if (!t.value || !Number.isFinite(n) || n < 1 || n > MAX_CLOCKS) return;
      settings.tablePerLine = n;
      break;
    }
    case 'spacing':
      settings.spacing = Number(t.value);
      spacingOut.textContent = `${t.value}px`;
      break;
    case 'size':
      settings.size = t.value as Settings['size'];
      break;
    case 'theme':
      settings.theme = t.value as Settings['theme'];
      break;
    case 'opacity':
      settings.opacity = Number(t.value) / 100;
      opacityOut.textContent = `${t.value}%`;
      break;
    case 'dock':
      settings.dock = t.value as Settings['dock'];
      break;
    case 'dockAutoHide':
      settings.dockAutoHide = t.checked;
      // The edge strip is useless if other windows can cover it.
      if (t.checked && !settings.alwaysOnTop) {
        settings.alwaysOnTop = true;
        (input('alwaysOnTop') as HTMLInputElement).checked = true;
        syncDependentFields();
        commit(true);
        return;
      }
      break;
    case 'alwaysOnTop':
    case 'clickThrough':
    case 'autostart':
    case 'autoUpdate':
      settings[t.name] = t.checked;
      syncDependentFields();
      commit(true);
      return;
    default:
      return;
  }
  syncDependentFields();
  commit();
});

// --- Clock list (add / remove / reorder) ------------------------------------

function updateCount(): void {
  const total = settings.clocks.length + (settings.showLocal ? 1 : 0);
  countEl.textContent = `${total} / ${MAX_CLOCKS}`;
  const full = settings.clocks.length >= maxExtraClocks(settings);
  search.disabled = full;
  search.placeholder = full
    ? `Limit of ${MAX_CLOCKS} clocks reached`
    : 'Add a time zone — search city, country or offset…';
}

function move(from: number, to: number): void {
  if (to < 0 || to >= settings.clocks.length || from === to) return;
  const [item] = settings.clocks.splice(from, 1);
  settings.clocks.splice(to, 0, item);
  renderList();
  commit();
}

function iconButton(cls: string, title: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn ${cls}`;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

let dragIndex = -1;

function renderList(): void {
  const now = new Date();
  list.replaceChildren(
    ...settings.clocks.map((c, i) => {
      const li = document.createElement('li');
      li.className = 'clock-item';
      li.dataset.index = String(i);

      const handle = document.createElement('span');
      handle.className = 'handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      // Only the handle starts a drag, so text in the label input stays selectable.
      handle.addEventListener('pointerdown', () => (li.draggable = true));

      const main = document.createElement('div');
      main.className = 'item-main';
      const label = document.createElement('input');
      label.className = 'text label-input';
      label.value = c.label;
      label.placeholder = cityFromTimeZone(c.tz);
      label.setAttribute('aria-label', `Label for ${c.tz}`);
      label.addEventListener('input', () => {
        c.label = label.value;
        commit();
      });
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = `${c.tz} · ${formatUtcOffset(offsetMinutes(c.tz, now))}`;
      main.append(label, meta);

      li.append(
        handle,
        main,
        iconButton('up', 'Move up', '↑', () => move(i, i - 1)),
        iconButton('down', 'Move down', '↓', () => move(i, i + 1)),
        iconButton('remove', 'Remove', '✕', () => {
          settings.clocks.splice(i, 1);
          renderList();
          renderResults();
          commit();
        }),
      );

      li.addEventListener('dragstart', (e) => {
        dragIndex = i;
        li.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => {
        li.draggable = false;
        li.classList.remove('dragging');
        list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      });
      li.addEventListener('dragover', (e) => {
        if (dragIndex < 0) return;
        e.preventDefault();
        const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
        li.classList.toggle('drop-after', after);
        li.classList.toggle('drop-before', !after);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = li.classList.contains('drop-after');
        let to = i + (after ? 1 : 0);
        if (dragIndex < to) to--;
        const from = dragIndex;
        dragIndex = -1;
        move(from, to);
      });
      return li;
    }),
  );
  updateCount();
}

// --- Time zone picker -------------------------------------------------------

interface ZoneItem {
  tz: string;
  city: string;
  country: string;
  offset: number;
  offsetText: string;
  haystack: string;
  cityKey: string;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/−/g, '-')
    .replace(/[_/]/g, ' ')
    .toLowerCase();

let zones: ZoneItem[] | undefined;

function zoneIndex(): ZoneItem[] {
  if (zones) return zones;
  const now = new Date();
  const ids = new Set(Intl.supportedValuesOf('timeZone'));
  ids.add('UTC');
  zones = [...ids].map((tz) => {
    const city = cityFromTimeZone(tz);
    const { name, keywords } = countryText(canonicalId(tz));
    const offset = offsetMinutes(tz, now);
    const offsetText = formatUtcOffset(offset);
    return {
      tz,
      city,
      country: name,
      offset,
      offsetText,
      cityKey: fold(city),
      haystack: fold(`${city} ${name} ${keywords} ${tz} ${canonicalId(tz)} ${offsetText}`),
    };
  });
  zones.sort((a, b) => a.offset - b.offset || a.city.localeCompare(b.city));
  return zones;
}

function score(z: ZoneItem, q: string): number {
  if (!q) return 3;
  if (z.cityKey.startsWith(q)) return 0;
  if (z.cityKey.split(' ').some((w) => w.startsWith(q))) return 1;
  if (z.haystack.split(' ').some((w) => w.startsWith(q))) return 2;
  if (z.haystack.includes(q)) return 3;
  return -1;
}

function addZone(tz: string): void {
  if (settings.clocks.length >= maxExtraClocks(settings)) return;
  settings.clocks.push({ id: newId(), tz, label: '' });
  renderList();
  renderResults();
  commit();
}

function renderResults(): void {
  const q = fold(search.value.trim());
  const added = new Set(settings.clocks.map((c) => c.tz));
  const matches = zoneIndex()
    .map((z) => ({ z, s: score(z, q) }))
    .filter((m) => m.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, 80);

  results.replaceChildren(
    ...matches.map(({ z }) => {
      const li = document.createElement('li');
      li.className = 'tz-option';
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      const isAdded = added.has(z.tz);
      li.classList.toggle('added', isAdded);
      li.setAttribute('aria-disabled', String(isAdded));

      const name = document.createElement('span');
      name.className = 'tz-name';
      name.textContent = z.country ? `${z.city}, ${z.country}` : z.city;
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = `${isAdded ? 'added · ' : ''}${z.offsetText}`;
      li.append(name, meta);
      li.title = z.tz;

      const pickIt = () => {
        if (!isAdded) addZone(z.tz);
      };
      li.addEventListener('click', pickIt);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pickIt();
        }
      });
      return li;
    }),
  );
}

search.addEventListener('input', renderResults);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = results.querySelector<HTMLElement>('.tz-option:not(.added)');
    first?.click();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    results.querySelector<HTMLElement>('.tz-option')?.focus();
  }
});
results.addEventListener('keydown', (e) => {
  const cur = document.activeElement as HTMLElement | null;
  if (!cur?.classList.contains('tz-option')) return;
  if (e.key === 'ArrowDown') (cur.nextElementSibling as HTMLElement | null)?.focus();
  else if (e.key === 'ArrowUp') ((cur.previousElementSibling as HTMLElement | null) ?? search).focus();
  else return;
  e.preventDefault();
});

// --- Tabs --------------------------------------------------------------------

const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')];
const TAB_KEY = 'settings-tab';

function selectTab(tab: HTMLButtonElement, focus = false): void {
  for (const t of tabs) {
    const active = t === tab;
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')!)!.hidden = !active;
  }
  if (focus) tab.focus();
  window.scrollTo(0, 0);
  try {
    localStorage.setItem(TAB_KEY, tab.id);
  } catch {
    // Storage unavailable: the window just opens on the first tab next time.
  }
}

for (const t of tabs) t.addEventListener('click', () => selectTab(t));
document.querySelector('.tabs')!.addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
  if (next === undefined) return;
  ev.preventDefault();
  selectTab(tabs[(next + tabs.length) % tabs.length], true);
});

let savedTab: string | null = null;
try {
  savedTab = localStorage.getItem(TAB_KEY);
} catch {
  // Ignore; fall back to the first tab.
}
selectTab(tabs.find((t) => t.id === savedTab) ?? tabs[0]);

// --- Updates -----------------------------------------------------------------

const checkBtn = document.getElementById('btn-check-update') as HTMLButtonElement;
const installBtn = document.getElementById('btn-install-update') as HTMLButtonElement;
const updateStatusEl = document.getElementById('update-status')!;
const updateNotesEl = document.getElementById('update-notes')!;

function renderUpdate(s: UpdateStatus): void {
  const busy = s.state === 'checking' || s.state === 'downloading' || s.state === 'installing';
  checkBtn.disabled = busy;
  installBtn.hidden = s.state !== 'available';
  installBtn.disabled = busy;
  updateNotesEl.hidden = true;
  document.getElementById('tab-updates')!.classList.toggle('has-update', s.state === 'available');

  switch (s.state) {
    case 'idle':
      updateStatusEl.textContent = '';
      break;
    case 'checking':
      updateStatusEl.textContent = 'Checking…';
      break;
    case 'upToDate':
      updateStatusEl.textContent = 'You have the latest version.';
      break;
    case 'available':
      updateStatusEl.textContent = `Version ${s.version} is available.`;
      if (s.notes?.trim()) {
        updateNotesEl.textContent = s.notes.trim();
        updateNotesEl.hidden = false;
      }
      break;
    case 'downloading':
      updateStatusEl.textContent = s.percent === null ? 'Downloading…' : `Downloading… ${s.percent}%`;
      break;
    case 'installing':
      updateStatusEl.textContent = 'Installing — the app will restart.';
      break;
    case 'error':
      updateStatusEl.textContent = `Update check failed: ${s.message}`;
      break;
  }
}

checkBtn.addEventListener('click', () => void checkForUpdates().then(renderUpdate));
installBtn.addEventListener('click', () => void installUpdate().catch(() => {}));

// --- Boot -------------------------------------------------------------------

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(settings));

async function boot(): Promise<void> {
  settings = await loadSettings();
  applyAppearance(settings);
  document.getElementById('local-tz')!.textContent = `(${localTimeZone()})`;
  (input('localLabel') as HTMLInputElement).placeholder = `Local · ${cityFromTimeZone(localTimeZone())}`;
  fillDateFormats();
  populateForm();
  renderList();
  renderResults();

  getVersion()
    .then((v) => (document.getElementById('app-version')!.textContent = `v${v}`))
    .catch(() => {});
  renderUpdate(await getUpdateStatus());
  await onUpdateStatus(renderUpdate);

  invoke<string>('autostart_label')
    .then((l) => (document.getElementById('autostart-label')!.textContent = l))
    .catch(() => {});

  // Tray toggles (via the widget) and any other external change.
  await onSettingsChanged('settings', (s) => {
    settings = s;
    applyAppearance(settings);
    populateForm();
    renderList();
    renderResults();
  });
}

boot().catch((err) => console.error(err));
