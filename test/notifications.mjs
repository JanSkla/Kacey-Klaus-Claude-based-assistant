// The phone's notifications over a real (throwaway) database: notifications.js.
// Storing, the same message arriving twice, messaging threads, sensitivity,
// removals, read state, and the summary's cache and what it hides.
// Run: node test/notifications.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-notify-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const n = await import('../notifications.js');
const db = await import('../db.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const IG = n.INSTAGRAM;
const T0 = Date.parse('2026-10-05T10:00:00Z');
const dm = (sender, text, at, extra = {}) => ({
  key: `0|${IG}|1|dm|10123`, package: IG, app: 'Instagram', channel: 'ig_direct',
  posted_at: at, title: sender, text, sender, message: true, ...extra,
});

await test('an empty body stores nothing', () => {
  const out = n.ingest({});
  assert.deepEqual([out.fresh.length, out.duplicate, out.removed], [0, 0, 0]);
});

await test('a plain notification is stored as a notification', () => {
  const out = n.ingest({ items: [{ key: 'k-spot', package: 'com.spotify.music', app: 'Spotify', posted_at: T0, title: 'Nové album', text: 'Poslechni si to' }] });
  assert.equal(out.fresh.length, 1);
  assert.equal(out.fresh[0].kind, 'notification');
  assert.equal(n.list()[0].app, 'Spotify');
});

await test('each message of a MessagingStyle notification is its own row', () => {
  const out = n.ingest({ items: [dm('petr.k', 'ahoj', T0 + 1000), dm('petr.k', 'jdeš večer?', T0 + 2000)] });
  assert.equal(out.fresh.length, 2);
  assert.ok(out.fresh.every((r) => r.kind === 'message' && r.conversation === 'petr.k'));
});

await test('the next update of the same notification adds only the new message', () => {
  const out = n.ingest({ items: [dm('petr.k', 'ahoj', T0 + 1000), dm('petr.k', 'jdeš večer?', T0 + 2000), dm('petr.k', 'v 7', T0 + 3000)] });
  assert.equal(out.fresh.length, 1);
  assert.equal(out.duplicate, 2);
  assert.equal(n.thread(IG, 'petr.k').map((m) => m.text).join(' / '), 'ahoj / jdeš večer? / v 7');
});

await test('a group thread is keyed by its name, not the sender', () => {
  n.ingest({ items: [dm('jana', 'kdo má klíče?', T0 + 4000, { conversation: 'Spolubydlící', group: true })] });
  const t = n.threads(IG).find((x) => x.conversation === 'Spolubydlící');
  assert.ok(t);
  assert.equal(t.group, true);
  assert.equal(t.last.sender, 'jana');
});

await test('threads are latest first with unread counts', () => {
  const t = n.threads(IG);
  assert.deepEqual(t.map((x) => x.conversation), ['Spolubydlící', 'petr.k']);
  assert.equal(t[1].unread, 3);
});

await test('a direct-message channel counts as a message without MessagingStyle', () => {
  const out = n.ingest({ items: [{ package: 'com.example.chat', channel: 'direct_messages', posted_at: T0 + 5000, title: 'Eva', text: 'zavolej' }] });
  assert.equal(out.fresh[0].kind, 'message');
  assert.equal(out.fresh[0].conversation, 'Eva');
});

await test('a login code or a secret notification is local_only', () => {
  const out = n.ingest({ items: [
    { package: 'com.bank', posted_at: T0 + 6000, title: 'Banka', text: 'Váš ověřovací kód je 482913' },
    { package: 'com.vault', posted_at: T0 + 6001, title: 'Trezor', text: 'odemčeno', secret: true },
  ] });
  assert.deepEqual(out.fresh.map((r) => r.sensitivity), ['local_only', 'local_only']);
  const row = n.list({ package: 'com.bank' })[0];
  assert.equal(row.sensitive, true);
  assert.match(n.describe(row), /citlivé/);
  assert.doesNotMatch(n.describe(row), /482913/);
});

await test('an item with no title and no text is skipped', () => {
  const out = n.ingest({ items: [{ package: 'com.empty', posted_at: T0 }] });
  assert.equal(out.fresh.length, 0);
});

await test('a malformed body is refused', () => {
  assert.throws(() => n.ingest({ items: [{ package: '', posted_at: 'now' }] }));
});

await test('a removal marks the rows with that key', () => {
  const out = n.ingest({ removed: [{ key: `0|${IG}|1|dm|10123`, reason: 1 }] });
  assert.equal(out.removed, 4);
  assert.ok(n.thread(IG, 'petr.k').every((m) => m.removed));
});

await test('apps lists busiest unread first', () => {
  const a = n.apps();
  assert.equal(a[0].package, IG);
  assert.equal(a[0].unread, 4);
  assert.equal(a[0].messages, 4);
});

await test('read: one thread, then by id, then everything', () => {
  assert.equal(n.markRead({ package: IG, conversation: 'petr.k' }), 3);
  assert.equal(n.unreadCounts().dm, 1);
  const id = n.list({ package: 'com.spotify.music' })[0].id;
  assert.equal(n.markRead({ ids: [id, 'bogus'] }), 1);
  assert.equal(n.markRead({}), 0);
  assert.ok(n.markRead({ all: true }) > 0);
  assert.equal(n.unreadCounts().all, 0);
});

await test('nothing unread: no model call', async () => {
  const out = await n.summarize({ scope: 'all', runner: () => { throw new Error('called'); } });
  assert.equal(out.count, 0);
});

await test('the summary is cached until the unread set changes, and hides sensitive text', async () => {
  n.ingest({ items: [dm('ondra', 'máš chvilku?', T0 + 7000), { package: 'com.bank', posted_at: T0 + 7001, title: 'Banka', text: 'kód 123456 pro přihlášení' }] });
  let calls = 0;
  let seen = '';
  const runner = async ({ prompt }) => { calls++; seen = prompt; return 'Ondra se ptá, jestli máš chvilku.'; };
  const a = await n.summarize({ scope: 'all', runner });
  const b = await n.summarize({ scope: 'all', runner });
  assert.equal(calls, 1);
  assert.equal(b.cached, true);
  assert.equal(a.text, 'Ondra se ptá, jestli máš chvilku.');
  assert.doesNotMatch(seen, /123456/);
  n.ingest({ items: [dm('ondra', 'tak nic', T0 + 8000)] });
  await n.summarize({ scope: 'all', runner });
  assert.equal(calls, 2);
});

await test('the DM summary sees only Instagram messages', async () => {
  let seen = '';
  await n.summarize({ scope: 'dm', runner: async ({ prompt }) => { seen = prompt; return 'ok'; } });
  assert.match(seen, /ondra/);
  assert.doesNotMatch(seen, /Banka/);
});

await test('a real app name replaces a package name sent earlier', () => {
  n.ingest({ items: [{ package: 'com.life360', app: 'com.life360', posted_at: T0 + 9000, title: 'Hanzik', text: 'dorazil' }] });
  n.ingest({ items: [{ package: 'com.life360', app: 'Life360', posted_at: T0 + 9001, title: 'Hanzik', text: 'odešel' }] });
  assert.deepEqual([...new Set(n.list({ package: 'com.life360' }).map((r) => r.app))], ['Life360']);
});

await test('old rows are purged', () => {
  n.ingest({ items: [{ package: 'com.old', posted_at: Date.now() - 400 * 86400000, title: 'staré', text: 'x' }] });
  assert.equal(n.list({ package: 'com.old' }).length, 1);
  assert.ok(n.purgeOld(Date.now() + 2 * 3600000) >= 1);
  assert.equal(n.list({ package: 'com.old' }).length, 0);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`notifications: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
