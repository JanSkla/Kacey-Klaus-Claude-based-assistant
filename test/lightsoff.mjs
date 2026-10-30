// Světla — "Vypnout vše": lightsoff.js (every lamp off at once, the answer read
// back from lightsd's status, a lamp that stays lit named, lightsd away or
// refusing, no lamps at all, the last run kept in the database, the preview's
// pretend press) and Kacey's app_lights.
// A stand-in lightsd on a free port, a throwaway database.
// Run: node test/lightsoff.mjs

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-lightsoff-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const db = await import('../db.js');
const lightsoff = await import('../lightsoff.js');
const { APP_TOOLS, APP_TOOL_NAMES } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

/* ---- the stand-in lightsd --------------------------------------------------- */

const ROOM = () => [
  { id: 'obyvak', name: 'Obývák', on: true },
  { id: 'loznice', name: 'Ložnice', on: true },
  { id: 'kuchyn', name: 'Kuchyň', on: false },
];
const ld = { lamps: ROOM(), stuck: [], refuse: false, calls: [] };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  ld.calls.push(`${req.method} ${url.pathname}`);
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/status') {
    return send(200, { lights: ld.lamps.map((l) => ({ id: l.id, name: l.name, output: { on: l.on, color: { brightness: 80 } } })), sleep: null });
  }
  if (url.pathname === '/api/lights') return send(200, { lights: ld.lamps.map((l) => ({ id: l.id, name: l.name })) });
  const m = /^\/api\/lights\/([^/]+)\/off$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (ld.refuse) return send(500, { error: 'bulb timeout' });
    const lamp = ld.lamps.find((l) => l.id === decodeURIComponent(m[1]));
    if (!lamp) return send(404, { error: 'no such light' });
    if (!ld.stuck.includes(lamp.id)) lamp.on = false;
    return send(200, { ok: true });
  }
  send(404, { error: 'not found' });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const URL_OK = `http://127.0.0.1:${server.address().port}`;
const URL_DOWN = 'http://127.0.0.1:9'; // nothing listens there
lightsoff.configure({ url: URL_OK, preview: false });

const events = [];
lightsoff.onEvent((ev) => events.push(ev));
const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');
const reset = () => {
  Object.assign(ld, { lamps: ROOM(), stuck: [], refuse: false, calls: [] });
  events.length = 0;
  db.kvSet('lights.all_off', null);
};

/* ---- reading lightsd ------------------------------------------------------------ */

await test('lit lamps are counted from the status; a lamp without output is dark', () => {
  assert.equal(lightsoff.countLit({ lights: [{ output: { on: true } }, { output: { on: false } }, { id: 'x' }] }), 1);
  assert.equal(lightsoff.countLit({}), 0);
  assert.equal(lightsoff.countLit(null), 0);
  assert.deepEqual(lightsoff.lampsOf({ lights: [{ id: 'a' }] }), [{ id: 'a', name: 'a', on: false }]);
});

await test('lamp words are Czech plurals', () => {
  assert.equal(lightsoff.lampWords(1), '1 světlo');
  assert.equal(lightsoff.lampWords(3), '3 světla');
  assert.equal(lightsoff.lampWords(5), '5 světel');
  assert.equal(lightsoff.lampWords(0), '0 světel');
});

await test('state reads what is lit, of how many', async () => {
  reset();
  const st = await lightsoff.state();
  assert.equal(st.lit, 2);
  assert.equal(st.total, 3);
});

/* ---- Vypnout vše ---------------------------------------------------------------- */

await test('every lamp gets the off call, and the answer is read back from the status', async () => {
  reset();
  const out = await lightsoff.allOff({ by: 'owner', origin: 'p1' });
  assert.equal(out.off, 3);
  assert.equal(out.total, 3);
  assert.equal(out.lit, 0);
  assert.deepEqual(out.still, []);
  for (const id of ['obyvak', 'loznice', 'kuchyn']) assert.ok(ld.calls.includes(`POST /api/lights/${id}/off`), id);
  assert.equal(ld.calls.at(-1), 'GET /api/status', 'the truth is read after the calls');
  assert.ok(ld.lamps.every((l) => !l.on));
});

await test('the run is kept in the database and told to every page', async () => {
  reset();
  await lightsoff.allOff({ by: 'owner', origin: 'p1' });
  const l = lightsoff.last();
  assert.equal(l.by, 'owner');
  assert.equal(l.off, 3);
  assert.equal(l.lit, 0);
  assert.ok(Date.parse(l.at) <= Date.now());
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'all_off');
  assert.equal(events[0].origin, 'p1');
  assert.equal(events[0].lit, 0);
});

await test('a lamp that ignored the call is named as still lit, not reported dark', async () => {
  reset();
  ld.stuck = ['loznice'];
  const out = await lightsoff.allOff();
  assert.equal(out.lit, 1);
  assert.deepEqual(out.still, ['Ložnice']);
  assert.match(lightsoff.describe(out), /pořád svítí: Ložnice/);
});

await test('lightsd turning none off is a refusal, and nothing is kept', async () => {
  reset();
  ld.refuse = true;
  await assert.rejects(lightsoff.allOff(), (e) => e.status === 502 && e.code === 'refused' && /žádnou lampu/.test(e.message));
  assert.equal(lightsoff.last(), null);
  assert.equal(events.length, 0);
});

await test('lightsd away: allOff and state fail as unreachable', async () => {
  reset();
  lightsoff.configure({ url: URL_DOWN });
  try {
    await assert.rejects(lightsoff.allOff(), (e) => e.status === 502 && e.code === 'unreachable' && /lightsd neodpovídá/.test(e.message));
    await assert.rejects(lightsoff.state(), (e) => e.code === 'unreachable');
    assert.equal(events.length, 0);
  } finally {
    lightsoff.configure({ url: URL_OK });
  }
});

await test('no lamps at all: nothing to switch, nothing called, said plainly', async () => {
  reset();
  ld.lamps = [];
  const out = await lightsoff.allOff();
  assert.deepEqual([out.off, out.total, out.lit], [0, 0, 0]);
  assert.ok(!ld.calls.some((c) => c.startsWith('POST')));
  assert.match(lightsoff.describe(out), /žádnou lampu/);
});

await test('a preview only pretends: no lamp is called, nothing is kept', async () => {
  reset();
  lightsoff.configure({ preview: true });
  try {
    const out = await lightsoff.allOff({ by: 'owner' });
    assert.equal(out.preview, true);
    assert.equal(out.lit, 2, 'the real lamps stay as they were');
    assert.ok(!ld.calls.some((c) => c.startsWith('POST')));
    assert.equal(lightsoff.last(), null);
    assert.equal(events[0].preview, true);
    assert.match(lightsoff.describe(out), /náhled/);
  } finally {
    lightsoff.configure({ preview: false });
  }
});

/* ---- Kacey ---------------------------------------------------------------------- */

await test('app_lights is on the allow-list', () => {
  assert.ok(APP_TOOL_NAMES.some((n) => n.endsWith('__app_lights')));
});

await test('app_lights status names what is lit', async () => {
  reset();
  const out = await call('app_lights', { action: 'status' });
  assert.ok(!out.isError, text(out));
  assert.match(text(out), /Svítí 2 světla z 3: Obývák, Ložnice/);
});

await test('app_lights all_off switches everything off as Kacey', async () => {
  reset();
  const out = await call('app_lights', { action: 'all_off' });
  assert.ok(!out.isError, text(out));
  assert.match(text(out), /Zhasnuto — vypnula jsem 3 světla/);
  assert.equal(lightsoff.last().by, 'kacey');
  assert.deepEqual(events.map((e) => e.by), ['kacey']);
  const st = await call('app_lights', { action: 'status' });
  assert.match(text(st), /Nic nesvítí.*Naposledy se zhasínalo všechno dnes, \d+:\d\d \(ty\)/);
});

await test('app_lights says which lamp stayed lit, as an error she must not hide', async () => {
  reset();
  ld.stuck = ['obyvak'];
  const out = await call('app_lights', { action: 'all_off' });
  assert.ok(out.isError);
  assert.match(text(out), /pořád svítí: Obývák/);
});

await test('app_lights with lightsd away says so in one go', async () => {
  reset();
  lightsoff.configure({ url: URL_DOWN });
  try {
    const out = await call('app_lights', { action: 'all_off' });
    assert.ok(out.isError);
    assert.match(text(out), /lightsd neodpovídá — světla teď zhasnout nejde/);
  } finally {
    lightsoff.configure({ url: URL_OK });
  }
});

server.close();
db.close();
console.log(`lightsoff: ${passed} passed`);
