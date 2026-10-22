// Run with `npm test` (Node 22.6+ strips the types natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatRelative, formatTime, formatUtcOffset, offsetMinutes, zonedTime, cityFromTimeZone } from './tz.ts';

const JAN = new Date('2026-01-15T00:00:00Z');
const JUL = new Date('2026-07-15T00:00:00Z');

test('half-hour and 45-minute zones, both DST seasons', () => {
  assert.equal(offsetMinutes('Asia/Kolkata', JAN), 330);
  assert.equal(offsetMinutes('Asia/Kolkata', JUL), 330);
  assert.equal(offsetMinutes('Australia/Adelaide', JAN), 630); // ACDT
  assert.equal(offsetMinutes('Australia/Adelaide', JUL), 570); // ACST
  assert.equal(offsetMinutes('Pacific/Chatham', JAN), 825); // +13:45
  assert.equal(offsetMinutes('Pacific/Chatham', JUL), 765); // +12:45
  assert.equal(formatUtcOffset(825), 'UTC+13:45');
  assert.equal(formatUtcOffset(-240), 'UTC−4');
  assert.equal(formatUtcOffset(0), 'UTC+0');
});

test('wall-clock time in offset zones', () => {
  const k = zonedTime('Asia/Kolkata', JAN);
  assert.deepEqual([k.hour, k.minute, k.day], [5, 30, 15]);
  const c = zonedTime('Pacific/Chatham', JAN);
  assert.deepEqual([c.hour, c.minute, c.day], [13, 45, 15]);
  const ny = zonedTime('America/New_York', JAN);
  assert.deepEqual([ny.hour, ny.day], [19, 14]); // previous calendar day
});

test('US DST boundary (2026-03-08 02:00 local)', () => {
  assert.equal(offsetMinutes('America/New_York', new Date('2026-03-08T06:59:59Z')), -300);
  assert.equal(offsetMinutes('America/New_York', new Date('2026-03-08T07:00:00Z')), -240);
  const after = zonedTime('America/New_York', new Date('2026-03-08T07:00:00Z'));
  assert.deepEqual([after.hour, after.minute], [3, 0]);
});

test('EU DST boundary (2026-10-25 01:00 UTC)', () => {
  assert.equal(offsetMinutes('Europe/London', new Date('2026-10-25T00:59:59Z')), 60);
  assert.equal(offsetMinutes('Europe/London', new Date('2026-10-25T01:00:00Z')), 0);
});

test('relative chips', () => {
  assert.equal(formatRelative(780), '+13h');
  assert.equal(formatRelative(-240), '−4h');
  assert.equal(formatRelative(330), '+5h30m');
  assert.equal(formatRelative(-30), '−30m');
  assert.equal(formatRelative(0), '±0h');
});

test('12h / 24h formatting', () => {
  const t = { year: 2026, month: 1, day: 1, hour: 0, minute: 5, second: 9 };
  assert.deepEqual(formatTime(t, false), { hm: '00:05', sec: '09', suffix: '' });
  assert.deepEqual(formatTime(t, true), { hm: '12:05', sec: '09', suffix: 'AM' });
  assert.deepEqual(formatTime({ ...t, hour: 13 }, true), { hm: '1:05', sec: '09', suffix: 'PM' });
});

test('date formats use the zone, not the machine', () => {
  // 00:30 UTC on Jan 15 is still Jan 14 in New York.
  const d = new Date('2026-01-15T00:30:00Z');
  assert.equal(formatDate('America/New_York', d, 'iso'), '2026-01-14');
  assert.equal(formatDate('Asia/Tokyo', d, 'iso'), '2026-01-15');
  assert.equal(formatDate('Asia/Tokyo', d, 'dayMonth'), 'Thu 15 Jan');
});

test('city labels', () => {
  assert.equal(cityFromTimeZone('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(cityFromTimeZone('Asia/Calcutta'), 'Kolkata');
});
