// Improving the app from the chat (selfupdate.js): the job from the popup to
// the switch, on a scratch git repo, with a stand-in for the coding agent and
// no preview process. Never the real repo, never the real agent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-upgrade-'));
const repo = path.join(dir, 'repo');
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');
process.env.KACEY_UPGRADE_REPO = repo;
process.env.KACEY_UPGRADE_DIR = path.join(dir, 'upgrades');
delete process.env.INVOCATION_ID;           // never "exit so systemd restarts" here
delete process.env.KACEY_RESTART_CMD;

const sh = (args, cwd = repo) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString().trim();
execFileSync('git', ['init', '-q', '-b', 'master', repo]);
writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.1', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
writeFileSync(path.join(repo, 'app.js'), 'export const tasks = [];\n');
sh(['add', '-A']);
sh(['commit', '-qm', 'start']);

const su = await import('../selfupdate.js');
const frames = [];
su.initSelfUpdate({ broadcast: (f) => frames.push(f), shutdown: () => { throw new Error('must not exit in a test'); } });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { process.exitCode = 1; console.error(`FAIL ${name}\n  ${err.stack || err.message}`); }
}

async function until(stage, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const j = su.current();
    if (j?.stage === stage) return j;
    if (j?.stage === 'failed') throw new Error(`failed: ${j.error}`);
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`stage ${su.current()?.stage}, wanted ${stage}`);
}

const SPEC = {
  title: 'Úkoly — třídění podle skupin', short: 'Úkoly — skupiny', slug: 'Úkoly skupiny!',
  request: 'Přidej novou funkci do úkolů, kde se úkoly mohou třídit podle skupin.',
  bullets: ['Skupiny úkolů, sbalitelné', 'Přepínač skupina / termín'], area: 'Úkoly', platforms: ['desktop'],
  view: 'tasks',
  questions: [
    { title: 'Jak vznikají skupiny?', key: 'Skupiny', multi: false, options: ['Ručně', 'Podle oblasti'], default: [1] },
    { title: 'Kde?', key: 'Oblast', multi: true, options: ['Úkoly', 'Domovská', 'Telefon'], default: [0, 1] },
  ],
};

/* The stand-in agent: writes a file per call, reports a plan, says one line. */
let calls = 0;
su._test.setAgent(async ({ prompt, dir: wd, report }) => {
  calls++;
  report(['Navrhuji obrazovku Úkoly', 'Domovská'], 0);
  report(null, 1);
  writeFileSync(path.join(wd, `step${calls}.txt`), prompt.slice(0, 200));
  return `Revize ${calls}: skupiny Práce · Zdraví.`;
});

await test('slugs are ASCII and branch-safe', () => {
  assert.equal(su.slugify('Úkoly — třídění podle skupin'), 'ukoly-trideni-podle-skupin');
  assert.equal(su.slugify('!!!'), 'funkce');
});

await test('a request with questions opens the questions popup', () => {
  const r = su.request(SPEC, 'sess-1');
  assert.equal(r.ok, true);
  const j = su.current();
  assert.equal(j.stage, 'questions');
  assert.equal(j.branch, 'kaceyFeature/ukoly-skupiny');
  assert.deepEqual(j.questions[1].def, [0, 1]);
  assert.equal(frames.at(-1).type, 'upgrade');
  assert.deepEqual(su.sessionsWithUpgrade(), ['sess-1']);
});

await test('a second request while one is waiting replaces the popup; while drafting it is refused', async () => {
  assert.equal(su.request({ ...SPEC, questions: [] }, null).ok, true);
  assert.equal(su.current().stage, 'confirm');
  su.cancel();
  assert.equal(su.current(), null);
  su.request(SPEC, 'sess-1');
});

await test('start → drafting on a kaceyFeature branch → review with revision 1', async () => {
  su.start({ answers: [[0], [2, 2, 9]], note: 'Zdraví nahoru' });
  const d = su.current();
  assert.equal(d.stage, 'drafting');
  assert.deepEqual(d.answers, [[0], [2]]);          // out-of-range dropped, duplicates merged
  assert.equal(su.request(SPEC, null).ok, false);   // busy
  const j = await until('review');
  assert.equal(j.revs.length, 1);
  assert.equal(j.viewRev, 1);
  assert.equal(j.summary, 'Revize 1: skupiny Práce · Zdraví.');
  assert.deepEqual(j.hist.map((h) => h.who), ['Jan · zadání', 'Jan · doplnění', 'Kacey · revize 1']);
  assert.match(sh(['log', '--oneline', 'kaceyFeature/ukoly-skupiny']), /návrh \(revize 1\)/);
  assert.equal(sh(['rev-parse', '--abbrev-ref', 'HEAD']), 'master');   // the running checkout did not move
  assert.equal(existsSync(path.join(repo, 'step1.txt')), false);
});

await test('the steps follow the agent\'s plan between the host\'s own', () => {
  const seen = frames.map((f) => f.job?.steps?.join(' | ')).filter(Boolean);
  assert.ok(seen.includes('Větev vytvořena | Navrhuji obrazovku Úkoly | Domovská | Commit a náhled'), seen.join('\n'));
});

await test('a prompt makes revision 2; restoring goes back to 1', async () => {
  su.refine({ text: 'Zdraví dej nahoru.' });
  assert.equal(su.current().stage, 'refining');
  let j = await until('review');
  assert.equal(j.revs.length, 2);
  assert.equal(j.viewRev, 2);
  assert.ok(existsSync(path.join(process.env.KACEY_UPGRADE_DIR, 'ukoly-skupiny', 'step2.txt')));
  await su.restorePrev();
  j = su.current();
  assert.equal(j.revs.length, 1);
  assert.equal(j.hist.at(-1).who, 'Kacey · revize 1');
  assert.equal(existsSync(path.join(process.env.KACEY_UPGRADE_DIR, 'ukoly-skupiny', 'step2.txt')), false);
});

await test('approve → finalizing → ready, the last number bumped, tests ran', async () => {
  su.approve();
  assert.equal(su.current().stage, 'finalizing');
  const j = await until('ready');
  assert.equal(j.versionTo, '1.0.2');
  assert.equal(j.restart, 'manual');
  const pkg = JSON.parse(readFileSync(path.join(process.env.KACEY_UPGRADE_DIR, 'ukoly-skupiny', 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.2');
});

await test('switch merges into the running checkout and clears the job', async () => {
  const out = await su.switchNow();
  assert.equal(out.restart, 'manual');
  assert.equal(su.current(), null);
  assert.ok(existsSync(path.join(repo, 'step1.txt')));
  assert.equal(JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '1.0.2');
  assert.equal(existsSync(path.join(process.env.KACEY_UPGRADE_DIR, 'ukoly-skupiny')), false);
  assert.equal(su.snapshot().last.version, '1.0.2');
  assert.equal(frames.at(-1).switching.version, '1.0.2');
});

await test('discarding deletes the branch, or keeps it archived', async () => {
  su.request({ ...SPEC, slug: 'kalendar', questions: [] }, null);
  su.start({});
  await until('review');
  await su.discard({ keep: true });
  assert.equal(su.current(), null);
  assert.equal(sh(['branch', '--list', 'kaceyFeature/kalendar']), 'kaceyFeature/kalendar');
  // The same name again gets a suffix rather than reusing the archived branch.
  su.request({ ...SPEC, slug: 'kalendar', questions: [] }, null);
  su.start({});
  const j = await until('review');
  assert.equal(j.branch, 'kaceyFeature/kalendar-2');
  await su.discard({ keep: false });
  assert.equal(sh(['branch', '--list', 'kaceyFeature/kalendar-2']), '');
});

await test('an agent that changes nothing fails the draft, and the job says why', async () => {
  su._test.setAgent(async () => 'Nic.');
  su.request({ ...SPEC, slug: 'prazdne', questions: [] }, null);
  su.start({});
  const end = Date.now() + 10000;
  while (su.current()?.stage !== 'failed' && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  assert.equal(su.current().stage, 'failed');
  assert.match(su.current().error, /nic nezměnil/);
  await su.discard({});
});

su.stopSelfUpdate();
const { closeDb } = await import('../db.js').catch(() => ({}));
if (closeDb) closeDb();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the db */ }
console.log(`selfupdate: ${passed} passed`);
