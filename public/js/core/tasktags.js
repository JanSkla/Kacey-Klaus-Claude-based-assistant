/* =========================================================================
   Task tags — what a task belongs to. Shared by the browser and the server.

   The owner's own list, in settings.taskTags: [{ id, name }]. It starts as
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
  rodina: ['mama', 'mame', 'mamu', 'mamk', 'mamin', 'tata', 'tatu', 'tatk', 'tatov', 'rodic', 'babick', 'babi',
    'deda', 'dedeck', 'sestr', 'bratr', 'brach', 'teta', 'tetu', 'stryc',
    'rodin', 'narozenin', 'darek', 'navstev', 'vanoc', 'syn', 'dcer', 'deti', 'manzel', 'svagr', 'neter',
    'synovec', 'vnouc', 'zavolat dom']
};

/** Lower case, no diacritics, one space between words, padded with spaces. */
function norm(s) {
  return ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/** The tag list from settings, or the starting five while there is none. */
export function tagsFrom(settings) {
  var list = settings && settings.taskTags;
  return Array.isArray(list) && list.length ? list : DEFAULT_TAGS;
}

/** The tag with this id in `tags`, or null. */
export function tagById(tags, id) {
  for (var i = 0; i < tags.length; i++) if (tags[i].id === id) return tags[i];
  return null;
}

/** The tag a word means — its id or its name, any case, with or without diacritics. */
export function tagByName(tags, word) {
  var w = norm(word);
  for (var i = 0; i < tags.length; i++) {
    if (norm(tags[i].id) === w || norm(tags[i].name) === w) return tags[i];
  }
  return null;
}

/* How strongly `text` points at `tag`: one point for every word that starts
   with one of its word beginnings (or contains a two-word one). */
function score(text, tag) {
  var words = WORDS[tag.id] ? WORDS[tag.id].slice() : [];
  norm(tag.name).trim().split(' ').forEach(function (w) { if (w.length >= 3) words.push(w.slice(0, 5)); });
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
