// Unsure calendar events over a real (throwaway) database: eventflags.js.
// Marking, the note, confirming, an unknown id, and a flag outliving its event.
// Run: node test/eventflags.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-flags-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

/* klaus_memory's calendar, as much of it as the flags read. */
{
  const k = new DatabaseSync(process.env.KLAUS_DB);
  k.exec('CREATE TABLE calendar_event (event_id TEXT PRIMARY KEY, title TEXT, starts_at TEXT, ends_at TEXT, source TEXT)');
  const add = k.prepare('INSERT INTO calendar_event VALUES (?, ?, ?, ?, ?)');
  add.run('ev_poster', 'Koncert v Lucerně', '2026-10-10T19:00:00', '2026-10-10T22:00:00', 'osobní');
  add.run('ev_later', 'Výstava', '2026-10-20T10:00:00', null, 'osobní');
  add.run('ev_gone', 'Smazaná', '2026-10-05T10:00:00', null, 'osobní');
  k.close();
}

const flags = await import('../eventflags.js');
const db = await import('../db.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

test('nothing is unsure to begin with', () => {
  assert.equal(flags.tentativeMap().size, 0);
  assert.deepEqual(flags.listTentative(), []);
});

test('marking keeps the note and lists soonest first', () => {
  flags.setTentative('ev_later', true);
  flags.setTentative('ev_poster', true, 'podle počasí');
  const map = flags.tentativeMap();
  assert.equal(map.get('ev_poster'), 'podle počasí');
  assert.equal(map.get('ev_later'), '');
  assert.deepEqual(flags.listTentative().map((e) => e.event_id), ['ev_poster', 'ev_later']);
});

test('marking twice updates the note, not a second row', () => {
  flags.setTentative('ev_poster', true, 'zeptat se Petra');
  assert.equal(flags.tentativeMap().get('ev_poster'), 'zeptat se Petra');
  assert.equal(flags.listTentative().length, 2);
});

test('confirming removes the flag', () => {
  flags.setTentative('ev_later', false);
  assert.equal(flags.tentativeMap().has('ev_later'), false);
});

test('an unknown or malformed id is refused', () => {
  assert.throws(() => flags.setTentative('ev_nope', true), /v kalendáři není/);
  assert.throws(() => flags.setTentative('DROP TABLE', true), /v kalendáři není/);
});

test('a flag whose event is gone is not listed, and dropFlag clears it', () => {
  flags.setTentative('ev_gone', true);
  db.open().prepare("DELETE FROM calendar_event WHERE event_id = 'ev_gone'").run();
  assert.ok(!flags.listTentative().some((e) => e.event_id === 'ev_gone'));
  flags.dropFlag('ev_gone');
  assert.equal(flags.tentativeMap().has('ev_gone'), false);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`eventflags: ${passed} passed`);
