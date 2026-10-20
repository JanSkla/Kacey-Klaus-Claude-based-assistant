// Whiteboards — public/js/core/board.js (the document, colours, geometry),
// whiteboard.js (boards in the database, files, the board in words, Kacey's
// operations) and Kacey's app_whiteboard_read / _edit / _manage.
// Throwaway database and folder.
// Run: node test/whiteboard.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-whiteboard-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_WHITEBOARD_DIR = path.join(dir, 'files');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const board = await import('../public/js/core/board.js');
const wbd = await import('../whiteboard.js');
const db = await import('../db.js');
const { makeWhiteboardTools } = await import('../app-tools.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const events = [];
wbd.onEvent((ev) => events.push(ev));
const text = (out) => out.content.map((c) => c.text).join('\n');
const item = (b, pred) => b.doc.items.find(pred);

/* ---- the document -------------------------------------------------------------- */

await test('colours are found by key and by their Czech name in any case', () => {
  assert.equal(board.colorKey('blue'), 'blue');
  assert.equal(board.colorKey('modrá'), 'blue');
  assert.equal(board.colorKey('Zelenou'), 'green');
  assert.equal(board.colorKey('červené'), 'red');
  assert.equal(board.colorKey('tyrkysovou'), 'teal');
  assert.equal(board.colorKey('duhová'), null);
  assert.equal(board.colorKey(''), null);
});

await test('normalizeDoc keeps what may be drawn and drops the rest', () => {
  const d = board.normalizeDoc({
    items: [
      { id: 'a', kind: 'text', x: 10.4, y: 'x', text: 'Ahoj', color: 'pink', by: 'kacey', kicker: 'ÚKOL' },
      { id: 'a', kind: 'text', text: 'dvojí id' },
      { id: 'b', kind: 'script', text: 'ne' },
      { id: 'c', kind: 'image', src: 'https://evil.example/x.png' },
      { id: 'd', kind: 'image', src: '/gallery-files/p1.jpg', color: 'nope' },
      { id: 'e', kind: 'doc', file: { name: 'a.pdf', url: 'javascript:alert(1)', bytes: 5 } },
      null,
    ],
    links: [
      { id: 'l1', from: 'a', to: 'd', label: 'pak' },
      { id: 'l2', from: 'a', to: 'gone' },
      { id: 'l3', from: 'a', to: 'a' },
    ],
    view: { x: 5, y: 6, z: 99 },
  });
  assert.deepEqual(d.items.map((it) => it.id), ['a', 'c', 'd', 'e']);
  const a = d.items[0];
  assert.equal(a.x, 10); assert.equal(a.y, 0);
  assert.equal(a.w, board.SIZES.text.w);
  assert.equal(a.color, 'pink'); assert.equal(a.by, 'kacey'); assert.equal(a.kicker, 'ÚKOL');
  assert.equal(d.items[1].src, '', 'a foreign image is not drawn');
  assert.equal(d.items[2].src, '/gallery-files/p1.jpg');
  assert.equal(d.items[2].color, board.DEFAULT_COLOR.image);
  assert.equal(d.items[3].file.url, '');
  assert.deepEqual(d.links, [{ id: 'l1', from: 'a', to: 'd', label: 'pak' }]);
  assert.equal(d.view.z, 3);
  assert.deepEqual(board.normalizeDoc('rubbish'), { items: [], links: [], view: { x: 0, y: 0, z: 1 } });
});

await test('a rectangle holds what has its centre inside, the innermost one is the parent', () => {
  const outer = { id: 'o', kind: 'rect', x: 0, y: 0, w: 600, h: 400 };
  const inner = { id: 'i', kind: 'rect', x: 24, y: 48, w: 240, h: 200 };
  const card = { id: 'c', kind: 'text', x: 48, y: 96, w: 120, h: 48 };
  const out = { id: 'x', kind: 'text', x: 700, y: 0, w: 120, h: 48 };
  const items = [outer, inner, card, out];
  assert.equal(board.parentOf(items, card), inner);
  assert.equal(board.parentOf(items, inner), outer);
  assert.equal(board.parentOf(items, out), null);
  assert.equal(board.holds(inner, outer), false, 'a smaller rectangle does not hold a bigger one');
});

await test('an arrow starts and ends on the edges of its objects', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  const b = { x: 300, y: 0, w: 100, h: 50 };
  const e = board.linkEnds(a, b);
  assert.deepEqual(e.a, { x: 100, y: 25 });
  assert.deepEqual(e.b, { x: 300, y: 25 });
});

/* ---- boards ---------------------------------------------------------------------- */

let duties;

await test('create, list, find by name; names stay unique', () => {
  duties = wbd.create({ name: '  Povinnosti   — říjen ' });
  assert.match(duties.id, /^b[a-z0-9]+$/);
  assert.equal(duties.name, 'Povinnosti — říjen');
  assert.equal(duties.rev, 1);
  assert.deepEqual(duties.doc.items, []);
  const twin = wbd.create({ name: 'povinnosti — ŘÍJEN' });
  assert.equal(twin.name, 'povinnosti — ŘÍJEN (2)');
  assert.equal(wbd.find('povinnosti — rijen').id, duties.id, 'the exact name, without case or diacritics, wins');
  assert.equal(wbd.find('povinnosti').id, twin.id, 'a part of the name finds the newest');
  assert.equal(wbd.find(duties.id).id, duties.id);
  assert.equal(wbd.find('nic takového'), null);
  assert.equal(wbd.list().length, 2);
  assert.equal(events.at(-1).event, 'created');
  assert.throws(() => wbd.create({ name: '   ' }), /jméno/);
  wbd.remove(twin.id);
});

await test('save keeps the revision; a page that missed a change gets a Conflict with the board as it is', () => {
  const doc = { items: [{ id: 't1', kind: 'text', x: 0, y: 0, text: 'První' }], links: [], view: { x: 10, y: 20, z: 1.5 } };
  const b = wbd.save(duties.id, doc, { rev: 1, origin: 'pgA' });
  assert.equal(b.rev, 2);
  assert.equal(b.doc.items[0].text, 'První');
  const ev = events.at(-1);
  assert.equal(ev.event, 'changed'); assert.equal(ev.by, 'page'); assert.equal(ev.origin, 'pgA');
  assert.equal(ev.summary.counts.items, 1);
  assert.throws(() => wbd.save(duties.id, doc, { rev: 1 }), (err) => err instanceof wbd.Conflict && err.board.rev === 2);
  // Kacey's writes never move where the page was looking.
  const k = wbd.save(duties.id, { ...doc, view: { x: 0, y: 0, z: 1 } }, { by: 'kacey' });
  assert.deepEqual(k.doc.view, { x: 10, y: 20, z: 1.5 });
  assert.throws(() => wbd.save('bnope', doc), /nemám/);
});

await test('rename does not count as an edit; duplicate copies the document under a new name', () => {
  const before = wbd.get(duties.id);
  const r = wbd.rename(duties.id, 'Povinnosti');
  assert.equal(r.name, 'Povinnosti');
  assert.equal(r.updated_at, before.updated_at);
  assert.equal(r.rev, before.rev);
  const c = wbd.duplicate(duties.id);
  assert.equal(c.name, 'Povinnosti — kopie');
  assert.notEqual(c.id, duties.id);
  assert.deepEqual(c.doc.items, before.doc.items);
  assert.equal(wbd.duplicate(duties.id).name, 'Povinnosti — kopie (2)');
  assert.throws(() => wbd.duplicate('bnope'), /nemám/);
});

await test('a deleted board can be put back, and its name is freed meanwhile', () => {
  const c = wbd.find('Povinnosti — kopie');
  assert.equal(wbd.remove(c.id), true);
  assert.equal(wbd.get(c.id), null);
  assert.equal(wbd.remove(c.id), false);
  assert.ok(!wbd.list().some((s) => s.id === c.id));
  const taken = wbd.create({ name: c.name });
  const back = wbd.restore(c.id);
  assert.equal(back.id, c.id);
  assert.equal(back.name, `${c.name} (3)`, 'its old name is taken now');
  assert.equal(events.at(-1).event, 'restored');
  assert.throws(() => wbd.restore('bnope'), /vrátit/);
  wbd.remove(taken.id); wbd.remove(back.id);
  wbd.remove(wbd.find('Povinnosti — kopie (2)').id);
});

await test('a summary carries the counts and a drawing, not the texts', () => {
  const s = wbd.summary(wbd.get(duties.id));
  assert.deepEqual(s.counts, { items: 1, links: 0 });
  assert.equal(s.preview.items[0].kind, 'text');
  assert.equal(s.preview.items[0].text, undefined);
  assert.deepEqual(s.preview.ids, ['t1']);
});

/* ---- files ------------------------------------------------------------------------- */

await test('a dropped text file is kept with its beginning, so Kacey can read it', () => {
  const f = wbd.saveFile({ name: 'seznam.txt', type: 'text/plain', data: Buffer.from('mléko\nchleba').toString('base64') });
  assert.match(f.url, /^\/whiteboard-files\/w[a-z0-9]+\.txt$/);
  assert.equal(f.bytes, Buffer.byteLength('mléko\nchleba'));
  assert.equal(f.excerpt, 'mléko\nchleba');
  assert.ok(existsSync(path.join(process.env.KACEY_WHITEBOARD_DIR, path.basename(f.url))));
  const pdf = wbd.saveFile({ name: '../../zpráva.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') });
  assert.equal(pdf.excerpt, undefined);
  assert.equal(pdf.name, '.._.._zpráva.pdf', 'no path in the name');
  assert.throws(() => wbd.saveFile({ name: 'x', data: 'not base64!' }), /celý/);
  assert.throws(() => wbd.saveFile({ name: 'x', data: '' }), /celý|prázdný/);
  assert.equal(readdirSync(process.env.KACEY_WHITEBOARD_DIR).length, 2);
});

/* ---- Kacey's operations --------------------------------------------------------------- */

let sorted;

await test('add areas and cards into them by ref, connect them, in one call', () => {
  sorted = wbd.create({ name: 'Třídění' });
  const r = wbd.applyOps(sorted, [
    { op: 'add', kind: 'rect', ref: 'work', text: 'Práce', color: 'modrá' },
    { op: 'add', kind: 'rect', ref: 'home', text: 'Domácnost', color: 'žlutou', near: 'work', side: 'right' },
    { op: 'add', ref: 'rep', text: 'Odevzdat report', kicker: 'ÚKOL · DNES 17:00', inside: 'work' },
    { op: 'add', ref: 'inv', text: 'Poslat fakturu', inside: 'work' },
    { op: 'add', ref: 'rent', text: 'Zaplatit nájem', inside: 'Domácnost' },
    { op: 'add', text: 'Volná myšlenka' },
    { op: 'connect', from: 'rep', to: 'inv', label: 'pak' },
    { op: 'add', kind: 'image', text: 'bez fotky' },
    { op: 'update', id: 'nic', color: 'red' },
  ]);
  assert.equal(r.counts.added, 7);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /#8 add: .*photo/);
  assert.match(r.errors[1], /#9 update: .*„nic“ na ploše není/);
  const b = r.board;
  sorted = b;
  const work = item(b, (it) => it.text === 'Práce');
  const home = item(b, (it) => it.text === 'Domácnost');
  assert.equal(work.color, 'blue'); assert.equal(home.color, 'amber');
  assert.ok(home.x >= work.x + work.w, 'Domácnost lies right of Práce');
  const rep = item(b, (it) => it.text === 'Odevzdat report');
  const inv = item(b, (it) => it.text === 'Poslat fakturu');
  const rent = item(b, (it) => it.text === 'Zaplatit nájem');
  const loose = item(b, (it) => it.text === 'Volná myšlenka');
  assert.equal(board.parentOf(b.doc.items, rep), work);
  assert.equal(board.parentOf(b.doc.items, inv), work);
  assert.equal(board.parentOf(b.doc.items, rent), home);
  assert.equal(board.parentOf(b.doc.items, loose), null);
  assert.ok(!board.overlaps(rep, inv), 'two cards in an area do not lie on each other');
  assert.equal(rep.kicker, 'ÚKOL · DNES 17:00');
  assert.equal(rep.by, 'kacey');
  assert.deepEqual(b.doc.links.map((l) => [l.from, l.to, l.label]), [[rep.id, inv.id, 'pak']]);
  for (const it of b.doc.items) assert.equal(it.x % board.GRID, 0, 'on the grid');
  assert.equal(events.at(-1).by, 'kacey');
  assert.deepEqual(events.at(-1).changes, { added: 7, changed: 0, removed: 0 });
});

await test('a full area grows to take another card', () => {
  const work = item(sorted, (it) => it.text === 'Práce');
  const h0 = work.h;
  const ops = Array.from({ length: 8 }, (_, i) => ({ op: 'add', text: `Úkol ${i + 1}`, inside: 'Práce' }));
  const b = wbd.applyOps(sorted, ops).board;
  const w2 = item(b, (it) => it.id === work.id);
  assert.ok(w2.h > h0, `grew from ${h0} to ${w2.h}`);
  for (let i = 1; i <= 8; i++) assert.equal(board.parentOf(b.doc.items, item(b, (it) => it.text === `Úkol ${i}`)), w2);
  sorted = b;
});

await test('moving an area carries what lies in it; a card moves by its text', () => {
  const work = item(sorted, (it) => it.text === 'Práce');
  const rep = item(sorted, (it) => it.text === 'Odevzdat report');
  const b = wbd.applyOps(sorted, [
    { op: 'update', id: work.id, dx: 0, dy: 480 },
    { op: 'update', id: 'Volná myšlenka', color: 'zelená', text: 'Volná myšlenka, delší' },
  ]).board;
  assert.equal(item(b, (it) => it.id === work.id).y, work.y + 480);
  assert.equal(item(b, (it) => it.id === rep.id).y, rep.y + 480);
  const loose = item(b, (it) => it.text === 'Volná myšlenka, delší');
  assert.equal(loose.color, 'green');
  sorted = b;
});

await test('a card moves into another area with inside', () => {
  const b = wbd.applyOps(sorted, [{ op: 'update', id: 'Poslat fakturu', inside: 'Domácnost' }]).board;
  const home = item(b, (it) => it.text === 'Domácnost');
  assert.equal(board.parentOf(b.doc.items, item(b, (it) => it.text === 'Poslat fakturu')), home);
  sorted = b;
});

await test('tidy lays an area out in reading order and fits it', () => {
  const home = item(sorted, (it) => it.text === 'Domácnost');
  const b = wbd.applyOps(sorted, [{ op: 'tidy', inside: home.id }]).board;
  const h2 = item(b, (it) => it.id === home.id);
  const kids = b.doc.items.filter((it) => board.parentOf(b.doc.items, it) === h2);
  assert.equal(kids.length, 2);
  kids.sort((a, c) => a.y - c.y || a.x - c.x);
  assert.equal(kids[0].x, h2.x + board.GRID);
  assert.equal(kids[0].y, h2.y + 2 * board.GRID, 'below the title');
  assert.ok(!board.overlaps(kids[0], kids[1]));
  assert.equal(h2.y + h2.h, Math.max(...kids.map((k) => k.y + k.h)) + board.GRID, 'fitted around them');
  assert.ok(wbd.applyOps(b, [{ op: 'tidy', id: 'Zaplatit nájem' }]).errors[0].includes('obdélníku'));
  sorted = b;
});

await test('disconnect, and delete an area with its contents and their arrows', () => {
  let b = wbd.applyOps(sorted, [{ op: 'connect', from: 'Zaplatit nájem', to: 'Poslat fakturu' }]).board;
  assert.equal(b.doc.links.length, 2);
  const r = wbd.applyOps(b, [{ op: 'disconnect', from: 'Odevzdat report', to: 'Poslat fakturu' }]);
  assert.equal(r.counts.removed, 1);
  b = r.board;
  assert.ok(wbd.applyOps(b, [{ op: 'disconnect', from: 'Odevzdat report', to: 'Poslat fakturu' }]).errors[0].includes('šipku'));
  const before = b.doc.items.length;
  b = wbd.applyOps(b, [{ op: 'delete', id: 'Domácnost', with_contents: true }]).board;
  assert.equal(b.doc.items.length, before - 3);
  assert.equal(b.doc.links.length, 0, 'the arrow between the two went with them');
  sorted = b;
});

await test('an operation list that changes nothing stores nothing', () => {
  const rev = sorted.rev;
  const r = wbd.applyOps(sorted, [{ op: 'delete', id: 'nic' }]);
  assert.equal(r.changes, 0);
  assert.equal(wbd.get(sorted.id).rev, rev);
});

await test('describe: areas with their contents, rough places, arrows, what the owner sees and picked', () => {
  const b = wbd.applyOps(sorted, [{ op: 'connect', from: 'Odevzdat report', to: 'Úkol 1', label: 'blokuje' }]).board;
  const rep = item(b, (it) => it.text === 'Odevzdat report');
  const work = item(b, (it) => it.text === 'Práce');
  const s = wbd.describe(b, { view: { x: 0, y: 0, w: 1200, h: 800, z: 0.8 }, selected: [rep.id, 'gone'] });
  assert.match(s, /^WHITEBOARD „Třídění“/);
  assert.match(s, /OBDÉLNÍKY/);
  assert.match(s, new RegExp(`${work.id} obdélník \\[modrá\\] „Práce“.* · obsahuje .*${rep.id}`));
  assert.match(s, new RegExp(`${rep.id} text \\[šedá\\] „Odevzdat report“ · štítek „ÚKOL · DNES 17:00“ · x -?\\d+ y -?\\d+ · \\d+×\\d+ · v „Práce“ \\(${work.id}\\), (vlevo|nahoře|uprostřed|vpravo|dole)`));
  assert.match(s, /ŠIPKY \(od → k\):\n- .*„Odevzdat report“ → .*„Úkol 1“ · popisek „blokuje“/);
  assert.match(s, /Pán teď vidí x 0…1200, y 0…800 \(zoom 80 %\)/);
  assert.match(s, new RegExp(`Pán má vybráno: ${rep.id} „Odevzdat report“ —`));
  assert.match(s, /přidala Kacey/);
  assert.match(wbd.describe(wbd.create({ name: 'Prázdná' })), /Plocha je prázdná/);
});

await test('clear empties the board', () => {
  const b = wbd.applyOps(wbd.find('Prázdná'), [{ op: 'add', text: 'x' }, { op: 'clear' }]).board;
  assert.equal(b.doc.items.length, 0);
});

/* ---- Kacey's tools ----------------------------------------------------------------------- */

await test('read: the open board without asking, or one named; none open is an error that says what to do', async () => {
  const [read] = makeWhiteboardTools({ board: () => ({ id: sorted.id, view: null, selected: [] }) });
  assert.match(text(await read.handler({}, {})), /WHITEBOARD „Třídění“/);
  assert.match(text(await read.handler({ board: 'povinnosti' }, {})), /WHITEBOARD „Povinnosti“/);
  const [none] = makeWhiteboardTools({ board: () => null });
  const out = await none.handler({}, {});
  assert.ok(out.isError);
  assert.match(text(out), /žádný whiteboard otevřený/);
  assert.ok((await none.handler({ board: 'neexistuje' }, {})).isError);
});

await test('edit: changes the open board and shows it in the chat; only failures are an error', async () => {
  const sent = [];
  const [, edit] = makeWhiteboardTools({ board: () => ({ id: sorted.id }), send: (f) => sent.push(f) });
  const out = await edit.handler({ ops: [{ op: 'add', kind: 'rect', ref: 's', text: 'Škola', color: 'fialová' }, { op: 'add', text: 'Diplomka', inside: 's' }] }, {});
  assert.ok(!out.isError);
  assert.match(text(out), /přidáno 2, upraveno 0, smazáno 0/);
  assert.match(text(out), /\(ref s\) obdélník „Škola“/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'whiteboard');
  assert.equal(sent[0].event, 'edited_chat');
  assert.equal(sent[0].board.id, sorted.id);
  assert.deepEqual(sent[0].counts, { added: 2, changed: 0, removed: 0 });
  const bad = await edit.handler({ ops: [{ op: 'delete', id: 'nic' }] }, {});
  assert.ok(bad.isError);
  assert.match(text(bad), /NEPOVEDLO SE/);
  assert.equal(sent.length, 1, 'nothing changed, nothing shown');
});

await test('manage: list, create and duplicate open the board, rename, delete', async () => {
  const sent = [];
  let open = { id: sorted.id };
  const [, , manage] = makeWhiteboardTools({ board: () => open, send: (f) => sent.push(f) });
  const list = text(await manage.handler({ action: 'list' }, {}));
  assert.match(list, new RegExp(`\\(${sorted.id}\\) „Třídění“ .* · OTEVŘENÝ`));
  assert.match(list, /„Povinnosti“/);
  const made = text(await manage.handler({ action: 'create', name: 'Víkend' }, {}));
  const id = /\((b[a-z0-9]+)\)/.exec(made)[1];
  assert.deepEqual(sent.at(-1), { type: 'whiteboard', event: 'open', id });
  open = { id };
  assert.match(text(await manage.handler({ action: 'rename', name: 'Víkend na chalupě' }, {})), /Víkend na chalupě/);
  assert.ok((await manage.handler({ action: 'rename' }, {})).isError);
  assert.match(text(await manage.handler({ action: 'duplicate', board: 'Třídění', name: 'Třídění 2' }, {})), /Kopie „Třídění 2“/);
  assert.equal(sent.at(-1).event, 'open');
  assert.match(text(await manage.handler({ action: 'delete' }, {})), /do týdne vrátit/);
  assert.equal(wbd.get(id), null);
  assert.match(text(await manage.handler({ action: 'open', board: 'Povinnosti' }, {})), /Otevřen/);
  assert.equal(sent.at(-1).id, duties.id);
});

/* ---- samples ------------------------------------------------------------------------------ */

await test('the preview samples are only made into an empty database', () => {
  assert.equal(wbd.seedSamples(), 0);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`whiteboard: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
