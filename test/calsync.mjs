// Calendar sync and invitation answers over a real (throwaway) database:
// calsync.js and Kacey's app_calendar_sync. The Python process is stood in
// for (runSync's `tool`); what it reports, what is kept, what a failure
// leaves, the frames, and one sync at a time.
// Run: node test/calsync.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-calsync-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

/* klaus_memory's calendar: the morning PU4 Testing (unanswered), the UiTesting
   sync (accepted), a Retro answered Možná, one invitation already over, and
   an own event that is no invitation at all. */
{
  const k = new DatabaseSync(process.env.KLAUS_DB);
  k.exec('CREATE TABLE calendar_event (event_id TEXT PRIMARY KEY, title TEXT, starts_at TEXT, ends_at TEXT, source TEXT)');
  const add = k.prepare('INSERT INTO calendar_event VALUES (?, ?, ?, ?, ?)');
  add.run('ev_pu4test', 'PU4 Testing', inHours(20), inHours(20.5), 'práce');
  add.run('ev_uisync', 'PU4 - UiTesting sync', inHours(22), inHours(22.5), 'práce');
  add.run('ev_retro', 'Retro Q4', inHours(30), inHours(31), 'práce');
  add.run('ev_oldinv', 'Včerejší porada', inHours(-26), inHours(-25), 'práce');
  add.run('ev_own', 'Zubař', inHours(48), inHours(49), 'osobní');
  k.close();
}

const db = await import('../db.js');
const calsync = await import('../calsync.js');
const { APP_TOOLS } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const frames = [];
calsync.setBroadcast((f) => frames.push(f));
const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');

const ANSWERS = {
  ev_pu4test: 'needsAction', ev_uisync: 'accepted', ev_retro: 'tentative', ev_oldinv: 'needsAction',
};

await test('nothing synced yet: no state, no answers', () => {
  assert.deepEqual(calsync.syncState(), { last: null, running: null });
  assert.equal(calsync.responseMap().size, 0);
  assert.deepEqual(calsync.listOpen(), []);
});

await test('a sync keeps every answer and counts the open ones still ahead', async () => {
  const last = await calsync.runSync('user', { tool: async () => ({ ok: true, events: 5, responses: ANSWERS }) });
  assert.equal(last.ok, true);
  assert.equal(last.by, 'user');
  assert.equal(last.events, 5);
  assert.equal(last.invites, 2, 'PU4 Testing and Retro; the accepted one and the past one do not count');
  assert.equal(last.last_ok_at, last.at);
  assert.equal(calsync.responseMap().get('ev_uisync'), 'accepted');
  assert.deepEqual(calsync.listOpen().map((e) => [e.event_id, e.status]),
    [['ev_pu4test', 'needsAction'], ['ev_retro', 'tentative']]);
  assert.deepEqual(calsync.syncState().last, last, 'kept in kacey_kv');
});

await test('frames say it started, then how it ended', () => {
  const mine = frames.filter((f) => f.type === 'calendar_sync');
  assert.equal(mine.length, 2);
  assert.equal(mine[0].running.by, 'user');
  assert.equal(mine[1].running, null);
  assert.equal(mine[1].last.invites, 2);
});

await test('an answer given in Google replaces the old one at the next sync', async () => {
  const last = await calsync.runSync('night', { tool: async () => ({ ok: true, events: 5, responses: { ...ANSWERS, ev_pu4test: 'accepted' } }) });
  assert.equal(last.by, 'night');
  assert.equal(last.invites, 1);
  assert.equal(calsync.responseMap().get('ev_pu4test'), 'accepted');
});

await test('answers that could not be read keep the old ones', async () => {
  await calsync.runSync('user', { tool: async () => ({ ok: true, events: 5, responses: null }) });
  assert.equal(calsync.responseMap().get('ev_retro'), 'tentative');
  assert.equal(calsync.listOpen().length, 1);
});

await test('unknown statuses and malformed ids are not stored', () => {
  const n = calsync.storeResponses({ ev_retro: 'tentative', ev_own: 'maybe', 'DROP TABLE': 'accepted' });
  assert.equal(n, 1);
  assert.equal(calsync.responseMap().size, 1);
  assert.equal(calsync.storeResponses([]), null);
});

await test('a failed sync keeps the answers and says which sync still holds', async () => {
  const before = calsync.syncState().last;
  const last = await calsync.runSync('user', { tool: async () => ({ ok: false, error: 'invalid_grant: Token has been expired or revoked.' }) });
  assert.equal(last.ok, false);
  assert.equal(last.error_cs, 'Google chce znovu přihlásit');
  assert.equal(last.last_ok_at, before.at);
  assert.equal(last.events, null);
  assert.equal(calsync.responseMap().get('ev_retro'), 'tentative', 'the "?" stay');
  assert.equal(last.invites, 1);
});

await test('a tool that throws is a failed sync, not a crash', async () => {
  const last = await calsync.runSync('night', { tool: async () => { throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'); } });
  assert.equal(last.ok, false);
  assert.equal(last.error_cs, 'bez sítě');
  assert.equal(calsync.syncState().running, null);
});

await test('the owner\'s words for a failure', () => {
  assert.equal(calsync.humanError('timed out after 120 s'), 'Google neodpověděl včas');
  assert.equal(calsync.humanError('chybí calendars.json — není s čím synchronizovat'), 'kalendáře nejsou nastavené');
  assert.equal(calsync.humanError("No module named 'klaus_memory'"), 'chybí klaus_memory nebo python');
  assert.equal(calsync.humanError('KeyError: x'), 'kalendář neodpověděl');
});

await test('one sync at a time: a second press joins the running one', async () => {
  let release, calls = 0;
  const slow = () => { calls++; return new Promise((r) => { release = () => r({ ok: true, events: 5, responses: ANSWERS }); }); };
  const a = calsync.runSync('night', { tool: slow });
  const b = calsync.runSync('user', { tool: slow });
  assert.equal(calsync.syncState().running.by, 'night');
  await new Promise((r) => setImmediate(r));
  release();
  const [la, lb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(la, lb);
  assert.equal(lb.by, 'night');
});

await test('a deleted event loses its answer', () => {
  calsync.dropResponse('ev_retro');
  assert.equal(calsync.responseMap().has('ev_retro'), false);
});

await test('responseOf: the stored answer first, then source_meta', () => {
  const map = new Map([['ev_a', 'accepted']]);
  assert.equal(calsync.responseOf('ev_a', { responseStatus: 'needsAction' }, map), 'accepted');
  assert.equal(calsync.responseOf('ev_b', { attendees: [{ email: 'x' }, { self: true, responseStatus: 'tentative' }] }, map), 'tentative');
  assert.equal(calsync.responseOf('ev_c', null, map), null);
});

/* ---- Kacey's tool ----------------------------------------------------------- */

await test('app_calendar_sync status and invites', async () => {
  const status = text(await call('app_calendar_sync', { action: 'status' }));
  assert.match(status, /Poslední synchronizace \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(v noci\) proběhla v pořádku/);
  const invites = text(await call('app_calendar_sync', { action: 'invites' }));
  assert.match(invites, /\(1\)/);
  assert.match(invites, /PU4 Testing .* bez odpovědi/);
  assert.doesNotMatch(invites, /UiTesting/);
});

await test('app_calendar_sync sync joins a running sync and reports the failure', async () => {
  let release;
  const run = calsync.runSync('night', { tool: () => new Promise((r) => { release = () => r({ ok: false, error: 'ECONNRESET' }); }) });
  const said = call('app_calendar_sync', { action: 'sync' });
  await new Promise((r) => setImmediate(r));
  release();
  await run;
  const out = await said;
  assert.equal(out.isError, true);
  assert.match(text(out), /nepovedla: bez sítě/);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`calsync: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
