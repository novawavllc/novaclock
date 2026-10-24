// Clock component: analog SVG face + digital readout for one time zone.
import {
  dayKey,
  formatDate,
  formatRelative,
  formatTime,
  formatUtcOffset,
  isDaytime,
  offsetMinutes,
  zonedTime,
  type DateFormat,
} from './tz.ts';

export interface ClockModel {
  tz: string;
  label: string;
  isLocal: boolean;
}

/** What to draw inside the analog face instead of below it. */
export interface DialPlacement {
  /** Date and time zone chips. */
  info: boolean;
  /** Location label. */
  label: boolean;
}

/** Values computed once per tick and shared by every clock. */
export interface TickContext {
  now: Date;
  localOffset: number;
  localDay: number;
  hour12: boolean;
  dateMode: 'off' | 'auto' | 'always';
  dateFormat: DateFormat;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildTicks(): string {
  let out = '';
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    out += `<line class="${major ? 'tick major' : 'tick'}" x1="50" y1="${major ? 6 : 7}" x2="50" y2="${major ? 13 : 9.5}" transform="rotate(${i * 6} 50 50)"/>`;
  }
  return out;
}
const TICKS = buildTicks();

const DIAL = `
  <circle class="dial" cx="50" cy="50" r="47"/>
  <g class="ticks">${TICKS}</g>`;

// Hands get their own layer above the dial so in-dial date/zone text sits underneath them.
const HANDS = `
  <line class="hand hour" x1="50" y1="54" x2="50" y2="27"/>
  <line class="hand minute" x1="50" y1="56" x2="50" y2="14"/>`;

// The second hand lives in its own <svg> layer, rotated with a CSS transform, so the
// 60 fps animation is handled by the compositor and never repaints the face.
const SECOND = `
  <g class="hand second"><line x1="50" y1="60" x2="50" y2="11"/><circle cx="50" cy="50" r="2.4"/></g>
  <circle class="pin" cx="50" cy="50" r="1.3"/>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};

export class ClockView {
  readonly root: HTMLElement;
  private readonly hourHand: SVGElement;
  private readonly minuteHand: SVGElement;
  private readonly secondHand: SVGElement;
  private readonly hmEl: HTMLElement;
  private readonly secEl: HTMLElement;
  private readonly suffixEl: HTMLElement;
  private readonly dateEl: HTMLElement;
  private readonly utcChip: HTMLElement;
  private readonly relChip: HTMLElement;
  // Last-written values, so a tick only touches the DOM when something changed.
  private last: Record<string, string> = {};

  constructor(
    private readonly model: ClockModel,
    inDial: DialPlacement = { info: false, label: false },
  ) {
    this.root = el('article', 'clock');
    if (model.isLocal) this.root.classList.add('local');

    const layer = (cls: string, markup: string) => {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', cls);
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.innerHTML = markup;
      return svg;
    };
    const face = el('div', 'face');
    const dial = layer('face-dial', DIAL);
    const hands = layer('face-hands', HANDS);
    this.secondHand = layer('face-second', SECOND);
    this.hourHand = hands.querySelector('.hour')!;
    this.minuteHand = hands.querySelector('.minute')!;

    const info = el('div', 'info');
    const label = el('div', 'label');
    label.textContent = model.label;
    label.title = model.tz;

    const time = el('div', 'time');
    this.hmEl = el('span', 'hm');
    this.secEl = el('span', 'sec');
    this.suffixEl = el('span', 'suffix');
    time.append(this.hmEl, this.secEl, this.suffixEl);

    this.dateEl = el('div', 'date');
    const chips = el('div', 'chips');
    this.utcChip = el('span', 'chip');
    this.relChip = el('span', 'chip rel');
    chips.append(this.utcChip);
    if (!model.isLocal) chips.append(this.relChip);

    // Above the pivot: label, then zone; below it: date. Whatever isn't in the dial stays in .info.
    const top = el('div', 'dial-info top');
    const bottom = el('div', 'dial-info bottom');
    if (inDial.label) top.append(label);
    else info.append(label);
    info.append(time);
    if (inDial.info) {
      top.append(chips);
      bottom.append(this.dateEl);
    } else {
      info.append(this.dateEl, chips);
    }
    // With the label also up top, the zone chips go on one row to leave it room.
    top.classList.toggle('with-label', inDial.label);
    face.append(dial);
    if (top.hasChildNodes()) face.append(top);
    if (bottom.hasChildNodes()) face.append(bottom);
    face.append(hands, this.secondHand);
    this.root.append(face, info);
  }

  private set(key: string, value: string, apply: () => void): boolean {
    if (this.last[key] === value) return false;
    this.last[key] = value;
    apply();
    return true;
  }

  /**
   * Once-per-second update: digital text, date, chips, day/night, hour + minute hands.
   * Returns true if text that can change the clock's width changed.
   */
  tick(ctx: TickContext): boolean {
    let resized = false;
    const { tz } = this.model;
    const t = zonedTime(tz, ctx.now);
    const f = formatTime(t, ctx.hour12);

    this.set('hm', f.hm, () => (this.hmEl.textContent = f.hm));
    this.set('sec', f.sec, () => (this.secEl.textContent = ':' + f.sec));
    resized = this.set('suffix', f.suffix, () => (this.suffixEl.textContent = f.suffix)) || resized;

    const day = isDaytime(t) ? 'day' : 'night';
    this.set('dn', day, () => {
      this.root.classList.toggle('day', day === 'day');
      this.root.classList.toggle('night', day === 'night');
    });

    const differs = dayKey(t) !== ctx.localDay;
    const showDate = ctx.dateMode === 'always' || (ctx.dateMode === 'auto' && differs);
    const dateText = showDate ? formatDate(tz, ctx.now, ctx.dateFormat) : '';
    resized =
      this.set('date', dateText, () => {
        this.dateEl.textContent = dateText;
        this.dateEl.title = dateText; // full text if a long format gets truncated
        this.dateEl.hidden = !showDate;
      }) || resized;
    this.set('differs', String(differs), () => this.root.classList.toggle('other-day', differs));

    const off = offsetMinutes(tz, ctx.now);
    const utc = formatUtcOffset(off);
    resized = this.set('utc', utc, () => (this.utcChip.textContent = utc)) || resized;
    if (!this.model.isLocal) {
      const rel = formatRelative(off - ctx.localOffset);
      resized = this.set('rel', rel, () => (this.relChip.textContent = rel)) || resized;
    }

    const minuteAngle = (t.minute + t.second / 60) * 6;
    const hourAngle = ((t.hour % 12) + t.minute / 60 + t.second / 3600) * 30;
    this.hourHand.setAttribute('transform', `rotate(${hourAngle.toFixed(2)} 50 50)`);
    this.minuteHand.setAttribute('transform', `rotate(${minuteAngle.toFixed(2)} 50 50)`);
    return resized;
  }

  /** Smooth second hand. Angle is identical for every zone (offsets are whole minutes). */
  setSecondAngle(angle: string): void {
    this.secondHand.style.transform = `rotate(${angle}deg)`;
  }
}
