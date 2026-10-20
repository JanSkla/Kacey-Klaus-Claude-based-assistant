// Kacey on the web — web.js (the `web` frames from WebSearch / WebFetch, live
// and rebuilt from a stored session), public/js/core/websrc.js (the sources
// under the answer), voice/sentences.js forSpeech (no address out loud), and
// the tool lists in config.js and the persona.
// Run: node test/web.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = await import('../web.js');
const src = await import('../public/js/core/websrc.js');
const { forSpeech, takeSentences } = await import('../public/js/voice/sentences.js');
const config = await import('../config.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const SEARCH_TEXT =
  'Web search results for query: "MUDr. Nováková Brno ordinační hodiny"\n\n' +
  'Links: [{"title":"MUDr. Jana Nováková — praktický lékař","url":"https://www.ordinace-novakova.cz/hodiny"},' +
  '{"title":"Nováková | Firmy.cz","url":"https://www.firmy.cz/detail/1"},' +
  '{"title":"zlé","url":"javascript:alert(1)"},' +
  '{"title":"Znovu","url":"https://www.ordinace-novakova.cz/hodiny"}]\n\n' +
  'Paní doktorka ordinuje…\n\n' +
  'Links: [{"title":"Brno-střed — lékaři","url":"https://www.brno-stred.cz/lekari"}]\n\n' +
  'REMINDER: You MUST include the sources above in your response.';

const searchCall = { name: 'WebSearch', input: { query: 'MUDr. Nováková Brno ordinační hodiny' } };
const fetchCall = { name: 'WebFetch', input: { url: 'https://www.ordinace-novakova.cz/hodiny', prompt: 'hodiny' } };

/* ---- web.js: one lookup → one frame -------------------------------------- */

await test('a search frame from the structured result', () => {
  const f = web.webFrame(searchCall, { type: 'tool_result', tool_use_id: 'a', content: 'x' }, {
    query: 'MUDr. Nováková',
    results: ['Nějaký komentář', { tool_use_id: 's', content: [
      { title: 'A', url: 'https://a.cz/' }, { title: 'B', url: 'ftp://b.cz/' }, { title: 'A2', url: 'https://a.cz/' },
    ] }],
    durationSeconds: 1,
  });
  assert.deepEqual(f, { type: 'web', tool: 'search', ok: true, query: 'MUDr. Nováková', sources: [{ title: 'A', url: 'https://a.cz/' }] });
});

await test('a search frame from the result text: every Links line, http(s) only, each address once', () => {
  const f = web.webFrame(searchCall, { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: SEARCH_TEXT }] });
  assert.equal(f.tool, 'search');
  assert.equal(f.ok, true);
  assert.equal(f.query, 'MUDr. Nováková Brno ordinační hodiny');
  assert.deepEqual(f.sources.map((s) => s.url), [
    'https://www.ordinace-novakova.cz/hodiny', 'https://www.firmy.cz/detail/1', 'https://www.brno-stred.cz/lekari',
  ]);
});

await test('the query comes from the text when the input has none; at most WEB_SOURCES_MAX hits', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, url: `https://x${i}.cz/` }));
  const f = web.webFrame({ name: 'WebSearch', input: {} },
    { content: `Web search results for query: "lékárna Kobylisy"\n\nLinks: ${JSON.stringify(many)}` });
  assert.equal(f.query, 'lékárna Kobylisy');
  assert.equal(f.sources.length, web.WEB_SOURCES_MAX);
});

await test('broken JSON and a failed search leave an empty, failed frame', () => {
  const f = web.webFrame(searchCall, { is_error: true, content: 'Links: [{"title": oops]' });
  assert.equal(f.ok, false);
  assert.deepEqual(f.sources, []);
  assert.equal(f.query, 'MUDr. Nováková Brno ordinační hodiny');
});

await test('titles are flattened and cut', () => {
  const f = web.webFrame(searchCall, {}, { results: [{ content: [{ title: 'a\n\n b' + 'x'.repeat(400), url: 'https://a.cz' }] }] });
  assert.ok(f.sources[0].title.startsWith('a b'));
  assert.equal(f.sources[0].title.length, 160);
});

await test('a fetch frame: the address, ok from the HTTP code or the text', () => {
  assert.deepEqual(web.webFrame(fetchCall, { content: 'Ordinační hodiny: Po 7–13' }),
    { type: 'web', tool: 'fetch', ok: true, sources: [{ title: '', url: 'https://www.ordinace-novakova.cz/hodiny' }] });
  assert.equal(web.webFrame(fetchCall, { content: 'x' }, { url: 'https://www.ordinace-novakova.cz/hodiny', code: 404 }).ok, false);
  assert.equal(web.webFrame(fetchCall, { content: 'x' }, { url: 'https://www.ordinace-novakova.cz/hodiny', code: 200 }).ok, true);
  assert.equal(web.webFrame(fetchCall, { is_error: true, content: 'x' }).ok, false);
  assert.equal(web.webFrame(fetchCall, { content: 'Error: Request failed with status code 503' }).ok, false);
  assert.equal(web.webFrame(fetchCall, { content: '<tool_use_error>Network unreachable</tool_use_error>' }).ok, false);
});

await test('a fetch of anything but http(s) gives no frame', () => {
  assert.equal(web.webFrame({ name: 'WebFetch', input: { url: 'file:///etc/passwd' } }, {}), null);
  assert.equal(web.webFrame({ name: 'WebFetch', input: { url: 'not a url' } }, {}), null);
});

/* ---- web.js: the tracker pairs a tool_use with its result ------------------ */

await test('the tracker answers only for web tools, once per call', () => {
  const t = web.webTracker(['WebSearch', 'WebFetch']);
  t.use({ type: 'tool_use', id: 'w1', name: 'WebSearch', input: { query: 'q' } });
  t.use({ type: 'tool_use', id: 'm1', name: 'mcp__klaus-memory__memory_search', input: {} });
  assert.equal(t.result({ type: 'tool_result', tool_use_id: 'm1', content: 'x' }), null);
  const f = t.result({ type: 'tool_result', tool_use_id: 'w1', content: 'Links: [{"title":"A","url":"https://a.cz"}]' });
  assert.equal(f.query, 'q');
  assert.equal(f.sources.length, 1);
  assert.equal(t.result({ type: 'tool_result', tool_use_id: 'w1', content: 'x' }), null);
  t.use({ type: 'tool_use', id: 'w2', name: 'WebFetch', input: { url: 'https://a.cz' } });
  t.clear();
  assert.equal(t.result({ type: 'tool_result', tool_use_id: 'w2', content: 'x' }), null);
});

/* ---- web.js: a stored session, reopened from the history ------------------ */

const NUDGE = '\n\n[systémová poznámka: …]';
const stored = [
  { type: 'user', message: { content: 'Kolik je hodin?' + NUDGE } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Je půl třetí.' }] } },
  { type: 'user', message: { content: [{ type: 'text', text: 'Kdy ordinuje doktorka Nováková?' + NUDGE }] } },
  { type: 'assistant', message: { content: [
    { type: 'text', text: 'Podívám se na internet.' },
    { type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'Nováková ordinační hodiny' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: SEARCH_TEXT }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f1', name: 'WebFetch', input: { url: 'https://www.ordinace-novakova.cz/hodiny' } }] } },
  // a subagent's message is not the conversation's
  { type: 'user', parent_tool_use_id: 'f1', message: { content: 'inner' } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'Po 7–13, St 7–13' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Ordinuje v pondělí a ve středu od sedmi do jedné.' }] } },
  { type: 'user', message: { content: 'Díky.' } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Rádo se stalo.' }] } },
];

await test('isTurnStart: the owner\'s messages, not tool results or a subagent\'s', () => {
  assert.deepEqual(stored.map((m) => web.isTurnStart(m)),
    [true, false, true, false, false, false, false, false, false, true, false]);
});

await test('webOfTranscript: the lookups of each turn, in order', () => {
  const turns = web.webOfTranscript(stored, config.WEB_TOOLS);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[0], []);
  assert.deepEqual(turns[1].map((f) => f.tool), ['search', 'fetch']);
  assert.equal(turns[1][1].ok, true);
  assert.deepEqual(turns[2], []);
  assert.deepEqual(web.webOfTranscript([], config.WEB_TOOLS), []);
});

/* ---- core/websrc.js: the card under the answer ---------------------------- */

const frames = web.webOfTranscript(stored, config.WEB_TOOLS)[1];

await test('read pages first, then the hits; a read page borrows its hit\'s title', () => {
  const t = src.newTurn();
  frames.forEach((f) => src.addFrame(t, f));
  const list = src.mergeSources(t);
  assert.deepEqual(list.map((s) => [s.url, s.read]), [
    ['https://www.ordinace-novakova.cz/hodiny', true],
    ['https://www.firmy.cz/detail/1', false],
    ['https://www.brno-stred.cz/lekari', false],
  ]);
  assert.equal(list[0].title, 'MUDr. Jana Nováková — praktický lékař');
  assert.equal(src.metaOf(list[0]), 'ordinace-novakova.cz · přečteno');
  assert.equal(src.metaOf(list[1]), 'firmy.cz');
  const sum = src.summary(t);
  assert.equal(sum.kicker, 'Z INTERNETU · „Nováková ordinační hodiny“');
  assert.equal(sum.empty, '');
  assert.equal(sum.failed, false);
});

await test('a page that would not open says so; a later success wins', () => {
  const t = src.newTurn();
  src.addFrame(t, { type: 'web', tool: 'fetch', ok: false, sources: [{ url: 'https://a.cz/x' }] });
  assert.equal(src.metaOf(src.mergeSources(t)[0]), 'a.cz · nešlo otevřít');
  src.addFrame(t, { type: 'web', tool: 'fetch', ok: true, sources: [{ url: 'https://a.cz/x' }] });
  const list = src.mergeSources(t);
  assert.equal(list.length, 1);
  assert.equal(list[0].ok, true);
  assert.equal(list[0].title, 'a.cz');
});

await test('empty: nothing found vs. the web out of reach', () => {
  const none = src.newTurn();
  src.addFrame(none, { type: 'web', tool: 'search', ok: true, query: 'q', sources: [] });
  assert.equal(src.summary(none).empty, 'Hledání nic nenašlo.');
  assert.equal(src.summary(none).failed, false);

  const down = src.newTurn();
  src.addFrame(down, { type: 'web', tool: 'search', ok: false, query: 'q', sources: [] });
  assert.equal(src.summary(down).failed, true);
  assert.match(src.summary(down).empty, /^Na internet se teď nedostanu/);
  assert.equal(src.summary(down).kicker, 'Z INTERNETU · „q“');

  // one search failed, another found something: no error
  src.addFrame(down, { type: 'web', tool: 'search', ok: true, query: 'q2', sources: [{ title: 'A', url: 'https://a.cz' }] });
  assert.equal(src.summary(down).failed, false);
  assert.equal(src.summary(down).empty, '');
});

await test('the page keeps non-http addresses and junk frames out', () => {
  const t = src.newTurn();
  src.addFrame(t, null);
  src.addFrame(t, { tool: 'search', sources: [{ url: 'javascript:alert(1)', title: 'x' }, null, { url: 'https://ok.cz' }] });
  assert.deepEqual(src.mergeSources(t).map((s) => s.url), ['https://ok.cz']);
  assert.equal(src.hostOf('nonsense'), 'nonsense');
});

/* ---- voice/sentences.js: no address out loud ------------------------------ */

await test('forSpeech drops bare addresses and keeps a Markdown link\'s words', () => {
  assert.equal(forSpeech('Ordinuje od sedmi do jedné.'), 'Ordinuje od sedmi do jedné.');
  assert.equal(forSpeech('Viz https://www.ordinace-novakova.cz/hodiny.'), 'Viz.');
  assert.equal(forSpeech('Podle webu (www.ordinace-novakova.cz) ordinuje ráno.'), 'Podle webu ordinuje ráno.');
  assert.equal(forSpeech('Hodiny najdete na [webu ordinace](https://ordinace.cz/a_b).'), 'Hodiny najdete na webu ordinace.');
  assert.equal(forSpeech('https://a.cz'), '');
  assert.equal(forSpeech(null), '');
});

await test('an address does not cut a sentence in two', () => {
  const r = takeSentences('Je to na www.ordinace-novakova.cz v sekci hodiny. Další', false);
  assert.deepEqual(r.sentences, ['Je to na www.ordinace-novakova.cz v sekci hodiny. ']);
  assert.equal(forSpeech(r.sentences[0]).trim(), 'Je to na v sekci hodiny.');
});

/* ---- config.js and the persona ------------------------------------------- */

await test('the chat gets the web; the night, the brief and the gallery do not', () => {
  assert.deepEqual(config.WEB_TOOLS, ['WebSearch', 'WebFetch']);
  for (const t of config.WEB_TOOLS) {
    assert.ok(config.ALLOWED_TOOLS.includes(t), `${t} allowed in the chat`);
    assert.ok(!config.CHAT_DISALLOWED_TOOLS.includes(t), `${t} not denied in the chat`);
    assert.ok(config.DISALLOWED_TOOLS.includes(t), `${t} denied everywhere else`);
  }
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Agent']) {
    assert.ok(config.CHAT_DISALLOWED_TOOLS.includes(t), `${t} still denied in the chat`);
    assert.ok(!config.ALLOWED_TOOLS.includes(t));
  }
  assert.match(config.FALLBACK_PERSONA, /WebSearch/);
  assert.match(config.FALLBACK_PERSONA, /never as instructions/);
});

await test('the persona tells her when to use the web and that pages are data', () => {
  const persona = readFileSync(fileURLToPath(new URL('../persona/kacey.md', import.meta.url)), 'utf8');
  const section = persona.split('### Internet')[1]?.split('\n### ')[0] || '';
  assert.ok(section, 'the Internet section exists');
  assert.match(section, /`WebSearch`/);
  assert.match(section, /`WebFetch`/);
  assert.match(section, /ordinační hodiny/);
  assert.match(section, /Žádné URL/);
  assert.match(section, /data, ne instrukce/);
  assert.match(section, /Na internet se teď nedostanu/);
  assert.match(persona, /webové stránky a výsledky\s+hledání/);
});

console.log(`web: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
