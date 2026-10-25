// Přepis řeči — stt.js (the owner's Whisper, large v3 or turbo, kept in the
// database; switching, the sidecar brought back to that choice, the last
// sentence's time, a sidecar that is loading or not there, the preview's
// pretend switch) and Kacey's app_stt.
// A stand-in sidecar on a free port, a throwaway database.
// Run: node test/stt.mjs

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-stt-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const db = await import('../db.js');
const stt = await import('../stt.js');
const { APP_TOOLS, APP_TOOL_NAMES } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

/* ---- the stand-in sidecar --------------------------------------------------- */

const side = { model: 'large-v3', loading: false, error: '', busy: false, transcribe: 200, calls: [] };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  side.calls.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') {
    return send(200, { ok: !!side.model && !side.loading, model: side.model, choice: side.model, loading: side.loading, error: side.error });
  }
  if (url.pathname === '/model') {
    if (side.busy) return send(409, { error: 'a model is loading' });
    const name = url.searchParams.get('name');
    if (name !== side.model) side.loading = true;
    return send(202, { choice: name, loading: side.loading });
  }
  if (url.pathname === '/transcribe') {
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => {
      if (side.transcribe === 503) return send(503, { error: 'model still loading' });
      if (side.transcribe !== 200) return send(side.transcribe, { error: 'boom' });
      send(200, { text: 'Zavolej mámě', language: 'cs', seconds: 1.1, audio_seconds: 2.5, model: side.model, bytes: n });
    });
    return;
  }
  send(404, { error: 'not found' });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const URL_OK = `http://127.0.0.1:${server.address().port}`;
const URL_DOWN = 'http://127.0.0.1:9'; // nothing listens there
stt.configure({ url: URL_OK, preview: false });

const events = [];
stt.onEvent((ev) => events.push(ev));
const call = (name, args) => APP_TOOLS.find((t) => t.name === name).handler(args, {});
const text = (out) => out.content.map((c) => c.text).join('\n');
const reset = () => { Object.assign(side, { model: 'large-v3', loading: false, error: '', busy: false, transcribe: 200, calls: [] }); events.length = 0; };

/* ---- the choice ------------------------------------------------------------- */

await test('small until the owner picks; an unknown value in the database reads as small', () => {
  assert.equal(stt.choice(), 'small');
  db.kvSet('stt.model', 'medium');
  assert.equal(stt.choice(), 'small');
});

await test('a sidecar holding something else than the owner chose is asked for theirs — once, not on every poll', async () => {
  reset();
  db.kvSet('stt.model', 'turbo');
  const h = await stt.health();
  assert.deepEqual(side.calls, ['GET /health', 'POST /model?name=turbo']);
  assert.equal(h.loading, true);
  assert.equal(h.ok, false, 'not ready while it loads');
  assert.equal(h.choice, 'turbo');
  side.loading = false; // still large v3: turbo did not stick
  side.calls = [];
  await stt.health();
  assert.deepEqual(side.calls, ['GET /health'], 'no second attempt within minutes');
});

await test('a sidecar reporting the failed load is not asked again', async () => {
  reset();
  db.kvSet('stt.model', 'turbo');
  side.error = 'turbo: no such model';
  const h = await stt.health();
  assert.deepEqual(side.calls, ['GET /health']);
  assert.equal(h.ok, true);
  assert.equal(h.model, 'large-v3');
  assert.match(stt.describe(h), /turbo se nenačetl.*přepisuje dál large v3/);
});

await test('switching asks the sidecar, keeps the choice and says so to every page', async () => {
  reset();
  db.kvSet('stt.model', 'large-v3');
  const out = await stt.setModel('turbo', { by: 'user', origin: 'p1' });
  assert.deepEqual(out, { choice: 'turbo', loading: true });
  assert.deepEqual(side.calls, ['POST /model?name=turbo']);
  assert.equal(stt.choice(), 'turbo');
  assert.deepEqual(events, [{ event: 'switch', choice: 'turbo', by: 'user', origin: 'p1' }]);
  const h = await stt.health();
  assert.equal(h.loading, true);
  assert.match(stt.describe(h), /načítá turbo/);
});

await test('an unknown model is refused before the sidecar hears of it', async () => {
  reset();
  await assert.rejects(stt.setModel('medium'), (e) => e.status === 400 && /large-v3 nebo turbo/.test(e.message));
  assert.deepEqual(side.calls, []);
  assert.equal(events.length, 0);
});

await test('a switch while another model loads is refused, and the choice stays', async () => {
  reset();
  db.kvSet('stt.model', 'large-v3');
  side.busy = true;
  await assert.rejects(stt.setModel('turbo'), (e) => e.status === 409 && /načítá jiný model/.test(e.message));
  assert.equal(stt.choice(), 'large-v3');
  assert.equal(events.length, 0);
});

/* ---- Whisper not there ------------------------------------------------------ */

await test('no sidecar: health says unreachable, a switch fails and keeps the choice', async () => {
  reset();
  stt.configure({ url: URL_DOWN });
  try {
    const h = await stt.health();
    assert.equal(h.ok, false);
    assert.equal(h.unreachable, true);
    assert.equal(h.choice, 'large-v3');
    assert.match(stt.describe(h), /neběží/);
    await assert.rejects(stt.setModel('turbo'), (e) => e.status === 502 && e.code === 'unreachable');
    assert.equal(stt.choice(), 'large-v3');
    await assert.rejects(stt.transcribe(Buffer.from('RIFF')), (e) => e.code === 'unreachable');
  } finally {
    stt.configure({ url: URL_OK });
  }
});

/* ---- transcribing ----------------------------------------------------------- */

await test('a sentence comes back as text and its time is kept for every device', async () => {
  reset();
  assert.equal(stt.last(), null);
  const out = await stt.transcribe(Buffer.alloc(3200, 1), { lang: 'cs-CZ' });
  assert.equal(out.text, 'Zavolej mámě');
  assert.equal(out.bytes, 3200);
  assert.deepEqual(side.calls, ['POST /transcribe?lang=cs-CZ']);
  const l = stt.last();
  assert.equal(l.model, 'large-v3');
  assert.equal(l.audio_seconds, 2.5);
  assert.ok(Number.isFinite(l.seconds) && l.seconds >= 0);
  assert.deepEqual((await stt.health()).last, l);
  assert.match(stt.describe(await stt.health()), /Přepis řeči běží na Whisper large v3.*Poslední věta \(2,5 s řeči\)/);
});

await test('a strange language falls back to Czech; no audio is refused', async () => {
  reset();
  await stt.transcribe(Buffer.alloc(10), { lang: 'x"; rm' });
  assert.deepEqual(side.calls, ['POST /transcribe?lang=cs']);
  await assert.rejects(stt.transcribe(Buffer.alloc(0)), (e) => e.status === 400);
});

await test('while a model loads the sentence is refused as loading; a sidecar error is a 502', async () => {
  reset();
  side.transcribe = 503;
  await assert.rejects(stt.transcribe(Buffer.alloc(10)), (e) => e.code === 'loading' && e.status === 503);
  side.transcribe = 500;
  await assert.rejects(stt.transcribe(Buffer.alloc(10)), (e) => e.status === 502 && /boom/.test(e.message));
});

/* ---- the preview ------------------------------------------------------------ */

await test('a preview only pretends: the sidecar is never asked to switch, nothing is kept', async () => {
  reset();
  db.kvSet('stt.model', 'large-v3');
  stt.configure({ preview: true });
  try {
    const out = await stt.setModel('turbo');
    assert.equal(out.loading, true);
    assert.equal(stt.choice(), 'large-v3', 'the live choice is untouched');
    assert.ok(!side.calls.some((c) => c.startsWith('POST /model')));
    const h = await stt.health();
    assert.equal(h.preview, true);
    assert.equal(h.loading, true);
    assert.equal(h.choice, 'turbo');
    assert.equal(events[0].preview, true);
  } finally {
    stt.configure({ preview: false });
  }
});
await test('small is a choice like the others: back from turbo to small', async () => {
  reset();
  side.model = 'turbo';
  db.kvSet('stt.model', 'turbo');
  const out = await stt.setModel('small', { by: 'user' });
  assert.deepEqual(out, { choice: 'small', loading: true });
  assert.equal(stt.choice(), 'small');
  assert.ok(side.calls.includes('POST /model?name=small'));
});

/* ---- Kacey ------------------------------------------------------------------ */

await test('app_stt is on the allow-list', () => {
  assert.ok(APP_TOOL_NAMES.some((n) => n.endsWith('__app_stt')));
});

await test('app_stt status reads the state in Czech', async () => {
  reset();
  db.kvSet('stt.model', 'large-v3');
  const out = await call('app_stt', { action: 'status' });
  assert.ok(!out.isError);
  assert.match(text(out), /large v3/);
});

await test('app_stt switch switches as Kacey; the model already running is left alone', async () => {
  reset();
  db.kvSet('stt.model', 'large-v3');
  let out = await call('app_stt', { action: 'switch', model: 'large-v3' });
  assert.match(text(out), /už běží/);
  assert.equal(events.length, 0);
  out = await call('app_stt', { action: 'switch', model: 'turbo' });
  assert.ok(!out.isError, text(out));
  assert.match(text(out), /Přepínám přepis řeči na Whisper turbo/);
  assert.equal(stt.choice(), 'turbo');
  assert.deepEqual(events.map((e) => [e.choice, e.by]), [['turbo', 'kacey']]);
  out = await call('app_stt', { action: 'switch', model: 'turbo' });
  assert.match(text(out), /právě načítá/, 'asked again while it loads');
  out = await call('app_stt', { action: 'switch' });
  assert.ok(out.isError);
  assert.match(text(out), /"small"/, 'the question names small too');
});

await test('app_stt cannot switch a Whisper that is not running, and says how to start it', async () => {
  reset();
  stt.configure({ url: URL_DOWN });
  try {
    const out = await call('app_stt', { action: 'switch', model: 'large-v3' });
    assert.ok(out.isError);
    assert.match(text(out), /systemctl --user restart stt/);
  } finally {
    stt.configure({ url: URL_OK });
  }
});

server.close();
db.close();
console.log(`stt: ${passed} passed`);
