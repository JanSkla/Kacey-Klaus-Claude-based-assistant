/* =========================================================================
   Task tags — what a task belongs to. Shared by the browser and the server.

   The owner's own list, in settings.taskTags: [{ id, name, hint? }]. It starts as
   Práce · Škola · Byt · Až bude volný čas · Rodina and is theirs to rename,
   add to and delete. A task carries one tag's `id` (`task.tag`), so a rename
   moves nothing; a task whose tag is gone shows as "Bez štítku".

   Every new task gets a tag when it is made: Kacey picks one in
   app_task_add, and anything added without her (the add form, the today
   panel, the night run, a page offline) gets guessTag()'s word match. The
   guess is only a first answer — the owner moves a task by dragging it.

   No DOM here, and no imports: server.js loads this file as it is.
   ========================================================================= */

export var DEFAULT_TAGS = [
  { id: 'prace', name: 'Práce' },
  { id: 'skola', name: 'Škola' },
  { id: 'byt', name: 'Byt' },
  { id: 'volno', name: 'Až bude volný čas' },
  { id: 'rodina', name: 'Rodina' }
];

/* Word beginnings, without diacritics, that point at the starting tags. Keyed
   by id, so they survive a rename ("Byt" → "Domácnost"). A tag of the owner's
   own is matched by the words of its name. */
var WORDS = {
  prace: ['prac', 'sef', 'koleg', 'meeting', 'porad', 'schuzk', 'klient', 'report', 'faktur', 'prezentac',
    'projekt', 'deadline', 'kancel', 'pohovor', 'smlouv', 'sprint', 'review', 'jira', 'tym', 'firm', 'mail',
    'nabidk', 'zakazn', 'vyplat', 'dovolen'],
  skola: ['skol', 'zkous', 'test', 'prednas', 'cviceni', 'seminar', 'semest', 'zapoc', 'diplom', 'bakal',
    'esej', 'referat', 'uceni', 'naucit', 'studi', 'fakult', 'profes', 'kredit', 'labor', 'domaci ukol',
    'kolokv', 'skript', 'predmet', 'rozvrh', 'ucitel', 'prijimack'],
  byt: ['byt', 'uklid', 'uklidit', 'vysat', 'vyluxo', 'vytrit', 'nadobi', 'prad', 'najem', 'najm', 'kytk',
    'zalit', 'oprav', 'kohout', 'zarovk', 'nakup', 'koupit', 'lednic', 'smeti', 'odpad', 'kos', 'elektrin',
    'energi', 'internet', 'pronajim', 'domacnost', 'myck', 'polic', 'nabyt', 'ikea', 'koupeln', 'kuchyn',
    'zachod', 'okna', 'povleceni', 'drogerie', 'potrav'],
  volno: ['precist', 'cteni', 'knih', 'film', 'serial', 'hrat', 'zahrat', 'kytar', 'hudb', 'vylet',
    'konick', 'hobby', 'podivat', 'zkusit', 'nekdy', 'jednou', 'koncert', 'galeri', 'muze', 'malov',
    'procházk', 'prochazk', 'kino', 'divadl', 'podcast', 'vaření', 'uvarit', 'upect'],
  rodina: ['mama', 'mame', 'mamu', 'mamk', 'mamc', 'mamin', 'tata', 'tatu', 'tatk', 'tatov', 'rodic', 'babick', 'babi',
    'deda', 'dedeck', 'sestr', 'bratr', 'brach', 'teta', 'tetu', 'stryc',
    'rodin', 'narozenin', 'darek', 'navstev', 'vanoc', 'syna', 'synov', 'synem', 'synka', 'dcer', 'deti', 'manzel', 'svagr', 'neter',
    'synovec', 'vnouc', 'zavolat dom']
};

/** Lower case, no diacritics, one space between words, padded with spaces. */
function norm(s) {
  return ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/** The longest name a tag may have. */
export var TAG_NAME_MAX = 40;

/** The longest description ("hint") a tag may have: what belongs under it, in
    the owner's words. Kacey reads it in app_read and sorts by it; guessTag()
    counts its words too. Optional — a tag without one has no `hint` key. */
export var TAG_HINT_MAX = 300;

/** The tag list from settings, or the starting five while there is none.
    An empty list is the owner's choice (they deleted them all) and stays empty. */
export function tagsFrom(settings) {
  var list = settings && settings.taskTags;
  return Array.isArray(list) ? list : DEFAULT_TAGS;
}

/** A stored tag list made safe: { id, name } strings, names trimmed and cut
    to TAG_NAME_MAX, no empty names, no id or name twice (the first one wins). */
export function normalizeTags(list) {
  if (!Array.isArray(list)) return DEFAULT_TAGS.slice();
  var out = [], ids = {}, names = {};
  list.forEach(function (g) {
    if (!g || typeof g !== 'object') return;
    var name = String(g.name == null ? '' : g.name).replace(/\s+/g, ' ').trim().slice(0, TAG_NAME_MAX);
    if (!name) return;
    var id = String(g.id == null ? '' : g.id).trim() || newTagId(name, out);
    var key = norm(name);
    if (ids[id] || names[key]) return;
    ids[id] = true; names[key] = true;
    var hint = String(g.hint == null ? '' : g.hint).replace(/\s+/g, ' ').trim().slice(0, TAG_HINT_MAX);
    out.push(hint ? { id: id, name: name, hint: hint } : { id: id, name: name });
  });
  return out;
}

/** Why a name cannot be a tag in `tags` (besides the one with `exceptId`), or ''. */
export function tagNameProblem(name, tags, exceptId) {
  var n = String(name || '').trim();
  if (!n) return 'Štítek potřebuje název.';
  if (n.length > TAG_NAME_MAX) return 'Název je moc dlouhý — nejvýš ' + TAG_NAME_MAX + ' znaků.';
  var taken = tags.some(function (g) { return g.id !== exceptId && norm(g.name) === norm(n); });
  return taken ? 'Takový štítek už je.' : '';
}

/** The tag with this id in `tags`, or null. */
export function tagById(tags, id) {
  for (var i = 0; i < tags.length; i++) if (tags[i].id === id) return tags[i];
  return null;
}

/** The tag a word means — its id or its name, any case, with or without diacritics. */
export function tagByName(tags, word) {
  var w = norm(word);
  if (w === '  ') return null;
  for (var i = 0; i < tags.length; i++) {
    if (norm(tags[i].id) === w || norm(tags[i].name) === w) return tags[i];
  }
  return null;
}

/* How strongly `text` points at `tag`: one point for every word that starts
   with one of its word beginnings (or contains a two-word one). The owner's
   description adds its longer words, so "nákupy" written under Byt counts. */
function score(text, tag) {
  var words = WORDS[tag.id] ? WORDS[tag.id].slice() : [];
  norm(tag.name).trim().split(' ').forEach(function (w) { if (w.length >= 3) words.push(w.slice(0, 5)); });
  norm(tag.hint).trim().split(' ').forEach(function (w) { if (w.length >= 5) words.push(w.slice(0, 5)); });
  var n = 0;
  words.forEach(function (w) {
    var k = w.indexOf(' ') > 0 ? norm(w).slice(0, -1) : ' ' + norm(w).trim();
    if (text.indexOf(k) !== -1) n++;
  });
  return n;
}

/** The id of the tag `label` most likely belongs to, or null when nothing fits. */
export function guessTag(label, tags) {
  var text = norm(label);
  var best = null, bestScore = 0;
  (tags || DEFAULT_TAGS).forEach(function (tag) {
    var s = score(text, tag);
    if (s > bestScore) { best = tag.id; bestScore = s; }
  });
  return best;
}

/** A new tag's id: the name without diacritics, made unique in `tags`. */
export function newTagId(name, tags) {
  var base = norm(name).trim().replace(/ /g, '-').slice(0, 24) || 'stitek';
  var id = base, n = 2;
  while (tagById(tags, id)) id = base + '-' + n++;
  return id;
}
