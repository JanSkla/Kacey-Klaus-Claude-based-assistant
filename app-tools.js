/**
 * Kacey — the tools that let her edit the app itself.
 *
 * klaus_memory owns memory and the calendar. This owns the rest of what is on
 * screen: the weekly routine, the task list, the journal. They run in THIS
 * process through the SDK's in-process MCP transport, so a tool call is a
 * function call against appstate.js — no subprocess, no socket, no second copy
 * of the document that could disagree with the one the browser reads.
 *
 * Every write goes through onWrite(), which is how the browser hears about it:
 * the server broadcasts an `app_changed` frame and open pages reload the
 * section. Without that, Kacey would change the routine and the planner would
 * happily sit there showing the old one.
 *
 * Writes that replace a lot at once (importing a routine from a screenshot,
 * which is the case this was built for) return the previous value so the
 * browser can offer a one-click undo. A model reading a screenshot will
 * sometimes get a block wrong, and repainting a week by hand is a real cost.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import * as appstate from './appstate.js';
import { LOGICAL_DAY_START_HOUR } from './config.js';
import { bucketOf, dueLabel, normalizeDue, parseDue, DAY_START_HOUR } from './public/js/core/due.js';
import { CATEGORY_KEYS, KINDS } from './public/js/core/routine-cats.js';
import { MAX_ITEMS, newKey } from './public/js/core/checklist.js';
import { guessTag, newTagId, tagById, tagByName, tagNameProblem, tagsFrom } from './public/js/core/tasktags.js';
import { logicalDateOf } from './rules.js';
import * as nightstore from './nightstore.js';
import * as eventflags from './eventflags.js';
import * as notifications from './notifications.js';
import * as routineDays from './routine-days.js';
import * as gallery from './gallery.js';
import {
  RuleSchema, explainIssues, describeRule, describeTrigger, describeTiming, describeItem,
} from './rules.js';

if (DAY_START_HOUR !== LOGICAL_DAY_START_HOUR) {
  console.warn('[app-tools] public/js/core/due.js DAY_START_HOUR differs from config LOGICAL_DAY_START_HOUR');
}

const BUCKET_WORDS = {
  overdue: 'PO TERMÍNU', past: 'hotovo dřív', today: 'dnes', week: 'tento týden', later: 'později', none: 'bez termínu',
};

/** One line of the task list as Kacey reads it. */
function describeTask(t, tags = tagsFrom(appstate.get().settings)) {
  const when = t.due_at
    ? `${t.due_at} (${dueLabel(t.due_at)}${t.duration ? `, ${t.duration} min` : ''}) — ${BUCKET_WORDS[bucketOf(t)]}`
    : BUCKET_WORDS.none;
  const tag = tagById(tags, t.tag);
  return `- [${t.done ? 'x' : ' '}] (${t.id}) [${tag ? tag.name : 'bez štítku'}] ${t.label} — ${when}${t.meta ? ` · ${t.meta}` : ''}`;
}

const TAG_HELP =
  'Štítek = k čemu úkol patří: jméno jednoho z vlastníkových štítků (vypíše je app_read, řádek ŠTÍTKY). ' +
  'Vyber ho sama podle obsahu úkolu. Nový štítek zakládej jen, když o něj pán řekne (app_task_tags).';

const DUE_HELP =
  'Termín, místní čas: "YYYY-MM-DD" = někdy ten den, "YYYY-MM-DDTHH:MM" = v ten čas ' +
  '(takový úkol se ukáže i v kalendáři). Dnešní datum máš v kontextu; den končí ve 4:00.';

export const APP_SERVER_NAME = 'kacey-app';

/* The routine's categories come from the file the browser uses too
   (public/js/core/routine-cats.js); the days are spelled here. */
const CATEGORIES = CATEGORY_KEYS;
const DAYS = ['po', 'ut', 'st', 'ct', 'pa', 'so', 'ne'];
const DAY_ALIASES = {
  po: 0, pondělí: 0, pondeli: 0, mon: 0, monday: 0, '0': 0,
  ut: 1, út: 1, úterý: 1, utery: 1, tue: 1, tuesday: 1, '1': 1,
  st: 2, středa: 2, streda: 2, wed: 2, wednesday: 2, '2': 2,
  ct: 3, čt: 3, čtvrtek: 3, ctvrtek: 3, thu: 3, thursday: 3, '3': 3,
  pa: 4, pá: 4, pátek: 4, patek: 4, fri: 4, friday: 4, '4': 4,
  so: 5, sobota: 5, sat: 5, saturday: 5, '5': 5,
  ne: 6, neděle: 6, nedele: 6, sun: 6, sunday: 6, '6': 6,
};

/** Called after every successful write, with the section name and an undo value. */
let onWrite = () => {};
export function setWriteListener(fn) { onWrite = typeof fn === 'function' ? fn : () => {}; }

/* ---- small helpers ------------------------------------------------------ */

function ok(text) { return { content: [{ type: 'text', text }] }; }
function fail(text) { return { content: [{ type: 'text', text }], isError: true }; }

/** 'HH:MM' -> minutes since midnight. Throws on anything else. */
function minutesOf(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock).trim());
  if (!m) throw new Error(`čas musí být "HH:MM", ne "${clock}"`);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 0 || mins > 1440) throw new Error(`čas mimo rozsah: "${clock}"`);
  return mins;
}

function hhmm(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

function dayIndex(day) {
  const key = String(day).trim().toLowerCase();
  if (key in DAY_ALIASES) return DAY_ALIASES[key];
  throw new Error(`neznámý den: "${day}"`);
}

/** The routine grid as human-readable blocks — what the model should read back. */
function describeRoutine(routine) {
  const lines = [];
  for (let day = 0; day < 7; day++) {
    const blocks = [];
    let cur = null;
    for (let i = 0; i < 96; i++) {
      const cat = routine.grid[day + '-' + i];
      if (cat && cur && cur.cat === cat) cur.n++;
      else { if (cur) blocks.push(cur); cur = cat ? { cat, i, n: 1 } : null; }
    }
    if (cur) blocks.push(cur);
    const text = blocks.map((b) => {
      const note = routine.notes[day + '-' + b.i];
      const i = (routine.info || {})[day + '-' + b.i] || {};
      const where = [i.kind && KINDS[i.kind] ? KINDS[i.kind].label : '', i.room, i.who].filter(Boolean).join(', ');
      return `${hhmm(b.i * 15)}-${hhmm((b.i + b.n) * 15)} ${b.cat}${note ? ` "${note}"` : ''}${where ? ` (${where})` : ''}`;
    }).join(', ');
    lines.push(`${DAYS[day]}: ${text || '(prázdné)'}`);
  }
  return lines.join('\n');
}

/* ---- the tools ---------------------------------------------------------- */

const appRead = tool(
  'app_read',
  'Přečti aktuální stav aplikace: týdenní rutina, úkoly, zápisy v deníku. ' +
    'Zavolej tohle PŘED úpravou, ať víš, co tam už je.',
  {
    section: z.enum(['all', 'routine', 'tasks', 'journal'])
      .describe('Která část. "all" vrátí všechno.'),
  },
  async ({ section }) => {
    const doc = appstate.get();
    const parts = [];

    if (section === 'all' || section === 'routine') {
      parts.push(
        `ROUTINE (vstávání ${hhmm(doc.routine.wake)}, spánek ${hhmm(doc.routine.sleep)}):\n` +
        describeRoutine(doc.routine),
      );
      /* The week as it will really be: the default plus each date's changes,
         and the recent past where it diverged (cemented, amendable). #n are
         the ids app_routine_alter's remove / keep_overlap take. */
      let days;
      try { days = routineDays.describeDays(); } catch (err) { days = `(nejde spočítat: ${err.message})`; }
      parts.push('ROUTINE DAYS (konkrétní dny; posledních 7 jen upravené, dalších 14 všechny):\n' + days);
    }
    if (section === 'all' || section === 'tasks') {
      const tags = tagsFrom(doc.settings);
      parts.push('ŠTÍTKY: ' + (tags.map((g) => g.name).join(' · ') || '(žádné — úkoly budou bez štítku)'));
      parts.push('TASKS:\n' + (doc.tasks.length
        ? doc.tasks.map((t) => describeTask(t, tags)).join('\n')
        : '(žádné)'));
    }
    if (section === 'all' || section === 'journal') {
      parts.push('JOURNAL:\n' + (doc.journal.entries.length
        ? doc.journal.entries.map((e) => `- (${e.id}) ${e.created.slice(0, 16)} "${e.title || 'bez názvu'}"${e.unfinished ? ' [rozepsané]' : ''}`).join('\n')
        : '(žádné)'));
    }
    return ok(parts.join('\n\n'));
  },
);

const routinePaint = tool(
  'app_routine_paint',
  'Natři bloky v týdenní rutině. Rutina je tvar běžného týdne — ne konkrétní ' +
    'události (ty patří do kalendáře). Používej pro import rozvrhu z obrázku ' +
    'nebo pro úpravu jednotlivých bloků. Čas se zaokrouhluje na 15 minut.',
  {
    blocks: z.array(z.object({
      days: z.array(z.string()).describe('Dny: "po","ut","st","ct","pa","so","ne" (nebo 0-6).'),
      from: z.string().describe('Začátek "HH:MM".'),
      to: z.string().describe('Konec "HH:MM".'),
      category: z.enum(CATEGORIES)
        .describe('Kategorie bloku.'),
      note: z.string().optional().describe('Volitelný popisek bloku, např. "Laborka" nebo název předmětu.'),
      room: z.string().max(80).optional().describe('Místnost, jak ji píše rozvrh, např. "T2:C2-85".'),
      who: z.string().max(80).optional().describe('Vyučující, např. "Fischer J."; víc lidí čárkou.'),
      kind: z.enum(['pr', 'cv', 'lab']).optional()
        .describe('Typ výuky podle rozvrhu: "pr" přednáška, "cv" cvičení, "lab" laboratoř. Jen u školních bloků.'),
    })).describe('Bloky k natření.'),
    replace: z.boolean().optional()
      .describe('true = nejdřív smaž celou stávající rutinu (import celého rozvrhu). ' +
                'false/vynecháno = jen přimaluj k tomu, co tam je.'),
  },
  async ({ blocks, replace }) => {
    const doc = appstate.get();
    const before = { grid: { ...doc.routine.grid }, notes: { ...doc.routine.notes }, info: { ...doc.routine.info } };

    const grid = replace ? {} : { ...doc.routine.grid };
    const notes = replace ? {} : { ...doc.routine.notes };
    const info = replace ? {} : { ...doc.routine.info };

    let painted = 0;
    const skipped = [];

    try {
      for (const block of blocks) {
        const from = minutesOf(block.from);
        const to = minutesOf(block.to);
        if (to <= from) throw new Error(`"${block.from}"-"${block.to}" nedává smysl`);

        for (const day of block.days) {
          const d = dayIndex(day);
          let first = null;
          for (let m = Math.floor(from / 15) * 15; m < to; m += 15) {
            // Sleep hours are not paintable — the same rule the planner enforces.
            if (m < doc.routine.wake || m >= doc.routine.sleep) {
              skipped.push(`${DAYS[d]} ${hhmm(m)}`);
              continue;
            }
            const slot = m / 15;
            grid[d + '-' + slot] = block.category;
            if (first === null) first = slot;
            painted++;
          }
          if (block.note && first !== null) notes[d + '-' + first] = block.note;
          if ((block.room || block.who || block.kind) && first !== null) {
            info[d + '-' + first] = {
              ...(block.room ? { room: block.room } : {}), ...(block.who ? { who: block.who } : {}), ...(block.kind ? { kind: block.kind } : {}),
            };
          }
        }
      }
    } catch (err) {
      return fail(`Nenatřeno: ${err.message}. Nic se nezměnilo.`);
    }

    /* Nothing landed — every slot fell in the sleep band. Writing and
       broadcasting here would pop an "app changed" toast for a change that did
       not happen, and hand the user an undo that undoes nothing. */
    if (!painted && !replace) {
      return fail(
        `Nenatřeno nic — všech ${skipped.length} slotů padlo do spánku ` +
        `(${hhmm(doc.routine.wake)}–${hhmm(doc.routine.sleep)}). ` +
        'Posuň vstávání nebo spánek přes app_routine_hours a zkus to znovu.',
      );
    }

    appstate.setSection('routine', { ...doc.routine, grid, notes, info });
    onWrite('routine', { ...doc.routine, ...before });

    const hours = Math.round(painted / 4 * 10) / 10;
    return ok(
      `Natřeno ${painted} patnáctiminutových bloků (${hours} h)` +
      (replace ? ', stará rutina smazána' : '') + '.' +
      (skipped.length ? ` Přeskočeno ${skipped.length} slotů ve spánku (${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}) — když je potřebuješ, posuň vstávání/spánek přes app_routine_hours.` : '') +
      '\n\nNový stav:\n' + describeRoutine({ grid, notes, info }),
    );
  },
);

const routineErase = tool(
  'app_routine_erase',
  'Smaž bloky z rutiny — buď konkrétní rozsah, nebo celou rutinu.',
  {
    all: z.boolean().optional().describe('true = smaž celou rutinu.'),
    days: z.array(z.string()).optional().describe('Dny, kterých se to týká (když ne "all").'),
    from: z.string().optional().describe('Začátek "HH:MM".'),
    to: z.string().optional().describe('Konec "HH:MM".'),
  },
  async ({ all, days, from, to }) => {
    const doc = appstate.get();
    const before = { grid: { ...doc.routine.grid }, notes: { ...doc.routine.notes }, info: { ...doc.routine.info } };

    if (all) {
      appstate.setSection('routine', { ...doc.routine, grid: {}, notes: {}, info: {} });
      onWrite('routine', { ...doc.routine, ...before });
      return ok('Celá rutina smazána.');
    }

    if (!days || !days.length || !from || !to) {
      return fail('Buď "all": true, nebo days + from + to. Nic se nezměnilo.');
    }

    const grid = { ...doc.routine.grid };
    const notes = { ...doc.routine.notes };
    const info = { ...doc.routine.info };
    let removed = 0;
    try {
      const f = minutesOf(from), t = minutesOf(to);
      for (const day of days) {
        const d = dayIndex(day);
        for (let m = Math.floor(f / 15) * 15; m < t; m += 15) {
          const key = d + '-' + (m / 15);
          if (key in grid) { delete grid[key]; removed++; }
          delete notes[key];
          delete info[key];
        }
      }
    } catch (err) {
      return fail(`Nesmazáno: ${err.message}. Nic se nezměnilo.`);
    }

    appstate.setSection('routine', { ...doc.routine, grid, notes, info });
    onWrite('routine', { ...doc.routine, ...before });
    return ok(`Smazáno ${removed} bloků.`);
  },
);

const routineHours = tool(
  'app_routine_hours',
  'Nastav čas vstávání a spánku. Hodiny mimo tenhle rozsah jsou v plánovači ' +
    'šrafované a nejdou natřít.',
  {
    wake: z.string().optional().describe('Vstávání "HH:MM".'),
    sleep: z.string().optional().describe('Spánek "HH:MM".'),
  },
  async ({ wake, sleep }) => {
    const doc = appstate.get();
    const before = { ...doc.routine };
    const next = { ...doc.routine };

    try {
      if (wake) next.wake = minutesOf(wake);
      if (sleep) next.sleep = minutesOf(sleep);
    } catch (err) {
      return fail(`${err.message}. Nic se nezměnilo.`);
    }
    if (next.sleep - next.wake < 240) {
      return fail('Mezi vstáváním a spánkem musí být aspoň 4 hodiny. Nic se nezměnilo.');
    }

    appstate.setSection('routine', next);
    onWrite('routine', before);
    return ok(`Vstávání ${hhmm(next.wake)}, spánek ${hhmm(next.sleep)}.`);
  },
);

/* One date's routine, not the default week (routine-days.js). The calendar's
   buttons call the same alter() with the same operations; the one thing only
   this tool can do is amend a day already cemented in history. */
const routineAlter = tool(
  'app_routine_alter',
  'Změň rutinu jen pro konkrétní den (nebo dny) — výchozí týden zůstane, jak je. ' +
    'Na nemoc, zrušený trénink, posunutou posilovnu, jednorázový blok. Stav konkrétních dnů a id změn (#n) vrátí app_read (ROUTINE DAYS). ' +
    'op: "cancel" (date + from/to bloku, volitelně category; bez from/to = celý den), ' +
    '"cancel_range" (from_date–to_date, volitelně categories, reason — dny nemoci), ' +
    '"add" (date, from, to, category, note…), ' +
    '"move" (date + from/to původního bloku, new_from, volitelně new_to a to_date v témž týdnu), ' +
    '"reset" (dates nebo from_date–to_date nebo group_id — vrátí dny na výchozí rutinu), ' +
    '"remove" (id — odebere jednu změnu, u přesunu celý přesun), ' +
    '"keep_overlap" (id přidaného bloku — překryv s výchozím blokem nechat, oba platí). ' +
    'Minulé dny jsou zapsané v historii; měnit je smíš jen ty, když pán řekne, že na to zapomněl. ' +
    'Když přidaný nebo přesunutý blok překryje výchozí blok, oba zůstanou vedle sebe a vrátí se ⚠: ' +
    'rozhodni sama, jestli výchozí blok zrušit (cancel), nebo nechat obojí (keep_overlap) — když to není jasné, zeptej se.',
  {
    op: z.enum(['cancel', 'cancel_range', 'add', 'move', 'reset', 'remove', 'keep_overlap']),
    date: z.string().optional().describe('Den "YYYY-MM-DD".'),
    from: z.string().optional().describe('Začátek "HH:MM" (u cancel/move: blok, kterého se to týká).'),
    to: z.string().optional().describe('Konec "HH:MM".'),
    category: z.enum(CATEGORIES).optional(),
    from_date: z.string().optional().describe('Začátek rozsahu dnů "YYYY-MM-DD".'),
    to_date: z.string().optional().describe('Konec rozsahu (včetně), nebo u move cílový den.'),
    categories: z.array(z.enum(CATEGORIES)).optional().describe('cancel_range: jen tyto kategorie; vynech = všechno.'),
    new_from: z.string().optional().describe('move: nový začátek "HH:MM".'),
    new_to: z.string().optional().describe('move: nový konec; vynech = stejná délka.'),
    dates: z.array(z.string()).optional().describe('reset: konkrétní dny.'),
    group_id: z.number().int().optional().describe('reset: celá skupina (přesun, dny nemoci).'),
    id: z.number().int().optional().describe('remove / keep_overlap: id změny (#n).'),
    note: z.string().max(80).optional(),
    room: z.string().max(80).optional(),
    who: z.string().max(80).optional(),
    reason: z.string().max(120).optional().describe('Proč, krátce: "nemoc", "doktor".'),
  },
  async (args) => {
    const input = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null));
    /* move's target day travels as to_date in the shared schema too. */
    let out;
    try {
      out = routineDays.alter(input, { origin: 'kacey' });
    } catch (err) {
      return fail(`${err.message}${/Nic se nezměnilo/.test(err.message) ? '' : ' Nic se nezměnilo.'}`);
    }
    onWrite('routine_days');
    const views = out.dates.slice(0, 7).map((d) => routineDays.describeDay(routineDays.dayView(d)));
    return ok([out.summary, ...out.warnings, '', 'Teď:', ...views].join('\n'));
  },
);

const taskAdd = tool(
  'app_task_add',
  'Přidej úkol do seznamu v aplikaci. Skupiny (po termínu, dnes, tento týden) ' +
    'se počítají z termínu samy — nastav termín, ne skupinu.',
  {
    label: z.string().describe('Co je potřeba udělat.'),
    due: z.string().optional().describe(DUE_HELP + ' Vynech = bez termínu.'),
    duration: z.number().int().min(5).max(1440).optional()
      .describe('Jen pro úkol s časem: kolik minut zabere (výchozí 30). Tak dlouhý blok bude v kalendáři.'),
    tag: z.string().describe(TAG_HELP),
    meta: z.string().optional().describe('Doplněk: kontext. Termín ani štítek sem nepiš.'),
  },
  async ({ label, due, duration, tag, meta }) => {
    const text = String(label || '').trim();
    if (!text) return fail('Prázdný úkol.');

    let dueAt;
    try { dueAt = normalizeDue(due); } catch (err) { return fail(err.message + ' Nic se nepřidalo.'); }

    const doc = appstate.get();
    const tags = tagsFrom(doc.settings);
    // A tag that is not one of the owner's: the text decides, as for a typed task.
    const picked = (tag && tagByName(tags, tag)) || tagById(tags, guessTag(text, tags));
    const before = doc.tasks.slice();
    const task = {
      id: 't' + Date.now(),
      label: text,
      meta: meta || 'přidala Kacey',
      done: false,
      due_at: dueAt,
      tag: picked ? picked.id : null,
      ...(duration && parseDue(dueAt)?.time ? { duration } : {}),
    };
    appstate.setSection('tasks', doc.tasks.concat([task]));
    onWrite('tasks', before);
    return ok(`Přidáno: ${describeTask(task).slice(2)}`);
  },
);

const taskUpdate = tool(
  'app_task_update',
  'Změň úkol — odškrtni ho, přejmenuj, změň nebo zruš termín, přesuň pod jiný štítek, nebo smaž. ' +
    'Id zjistíš z app_read.',
  {
    id: z.string().describe('Id úkolu z app_read.'),
    done: z.boolean().optional().describe('true = hotovo, false = zpět na nehotovo.'),
    label: z.string().optional().describe('Nový text úkolu.'),
    due: z.string().nullable().optional().describe(DUE_HELP + ' null = termín zrušit.'),
    duration: z.number().int().min(5).max(1440).optional().describe('Nová délka v minutách (jen úkol s časem).'),
    tag: z.string().optional().describe('Přesuň úkol pod jiný štítek. ' + TAG_HELP + ' "bez štítku" = štítek zrušit.'),
    remove: z.boolean().optional().describe('true = úkol smaž.'),
  },
  async ({ id, done, label, due, duration, tag, remove }) => {
    const doc = appstate.get();
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) return fail(`Úkol "${id}" neexistuje. Vypiš si je přes app_read.`);

    const tags = tagsFrom(doc.settings);
    const untag = tag !== undefined && tagByName([{ id: '', name: 'bez štítku' }], tag) !== null;
    const moved = tag === undefined || untag ? null : tagByName(tags, tag);
    if (tag !== undefined && !untag && !moved) {
      return fail(`Štítek "${tag}" neexistuje. Štítky: ${tags.map((g) => g.name).join(', ') || '(žádné)'}. Nic se nezměnilo.`);
    }

    const before = doc.tasks.slice();

    if (remove) {
      appstate.setSection('tasks', doc.tasks.filter((t) => t.id !== id));
      onWrite('tasks', before);
      return ok(`Smazáno: "${task.label}".`);
    }

    let dueAt = task.due_at;
    if (due !== undefined) {
      try { dueAt = normalizeDue(due); } catch (err) { return fail(err.message + ' Nic se nezměnilo.'); }
    }

    const next = doc.tasks.map((t) => (t.id === id ? {
      ...t,
      ...(done === undefined ? {} : { done }),
      ...(label ? { label } : {}),
      due_at: dueAt,
      ...(duration ? { duration } : {}),
      ...(moved ? { tag: moved.id } : untag ? { tag: null } : {}),
    } : t));
    appstate.setSection('tasks', next);
    onWrite('tasks', before);

    return ok(`Upraveno: ${describeTask(appstate.get().tasks.find((t) => t.id === id)).slice(2)}`);
  },
);

/* The owner's tags themselves (settings.taskTags). A task holds a tag's id,
   so a rename moves nothing; a deleted tag's tasks stay, "bez štítku". */
const taskTags = tool(
  'app_task_tags',
  'Uprav vlastníkovy štítky úkolů — přidej nový, přejmenuj, smaž, nebo změň pořadí. ' +
    'Jen když o to pán řekne. Úkoly smazaného štítku zůstanou, bez štítku; přesun úkolu je app_task_update.',
  {
    action: z.enum(['add', 'rename', 'remove', 'move']).describe('add = nový, rename = přejmenovat, remove = smazat, move = posunout v pořadí.'),
    name: z.string().describe('add: název nového štítku. Jinak: který štítek (jak ho vypíše app_read).'),
    new_name: z.string().optional().describe('rename: nový název.'),
    position: z.number().int().min(1).optional().describe('move: na kolikáté místo (1 = první).'),
  },
  async ({ action, name, new_name, position }) => {
    const doc = appstate.get();
    const tags = tagsFrom(doc.settings);
    const listed = () => tags.map((g) => g.name).join(', ') || '(žádné)';
    let next;

    if (action === 'add') {
      const clean = String(name || '').trim();
      const problem = tagNameProblem(clean, tags);
      if (problem) return fail(problem + ' Štítky: ' + listed() + '.');
      next = tags.concat([{ id: newTagId(clean, tags), name: clean }]);
    } else {
      const tag = tagByName(tags, name);
      if (!tag) return fail(`Štítek "${name}" neexistuje. Štítky: ${listed()}.`);
      if (action === 'rename') {
        const clean = String(new_name || '').trim();
        const problem = tagNameProblem(clean, tags, tag.id);
        if (problem) return fail(problem + ' Nic se nezměnilo.');
        next = tags.map((g) => (g.id === tag.id ? { id: g.id, name: clean } : g));
      } else if (action === 'remove') {
        const before = doc.tasks.slice();
        const n = doc.tasks.filter((t) => t.tag === tag.id).length;
        appstate.setSection('settings', { ...doc.settings, taskTags: tags.filter((g) => g.id !== tag.id) });
        if (n) {
          appstate.setSection('tasks', doc.tasks.map((t) => (t.tag === tag.id ? { ...t, tag: null } : t)));
          onWrite('tasks', before);
        } else onWrite('settings', doc.settings);
        const left = tagsFrom(appstate.get().settings).map((g) => g.name).join(' · ') || '(žádné)';
        return ok(`Štítek ${tag.name} smazán${n ? ` — úkolů teď bez štítku: ${n}` : ''}. Štítky: ${left}.`);
      } else {
        if (!position) return fail('Řekni, na kolikáté místo (position).');
        const rest = tags.filter((g) => g.id !== tag.id);
        const at = Math.min(position, tags.length) - 1;
        next = rest.slice(0, at).concat([tag], rest.slice(at));
      }
    }

    appstate.setSection('settings', { ...doc.settings, taskTags: next });
    onWrite('settings', doc.settings);
    return ok('Štítky: ' + tagsFrom(appstate.get().settings).map((g) => g.name).join(' · ') + '.');
  },
);

const journalAdd = tool(
  'app_journal_add',
  'Ulož zápis do deníku. Používej, jen když to uživatel chce — deník je jeho ' +
    'vlastní text, ne tvoje poznámky o něm.',
  {
    text: z.string().describe('Text zápisu.'),
    title: z.string().optional().describe('Nadpis. Když chybí, odvodí se z textu.'),
    tags: z.array(z.string()).optional().describe('Štítky.'),
  },
  async ({ text, title, tags }) => {
    const body = String(text || '').trim();
    if (!body) return fail('Prázdný zápis.');

    const doc = appstate.get();
    const before = { ...doc.journal, entries: doc.journal.entries.slice() };
    const entry = {
      id: 'j' + Date.now(),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      title: title || body.split(/[.\n]/)[0].split(/\s+/).slice(0, 6).join(' ') || 'Bez názvu',
      text: body,
      tags: tags || [],
      unfinished: false,
    };
    appstate.setSection('journal', { ...doc.journal, entries: doc.journal.entries.concat([entry]) });
    onWrite('journal', before);
    return ok(`Zápis uložen: "${entry.title}" (${body.split(/\s+/).length} slov).`);
  },
);

/* ---- the night routine's rules --------------------------------------------
   docs/DREAM.md §8. A rule turns a standing pattern ("whenever I have gym,
   remind me the evening before to pack my bag") into tasks the night run
   creates by itself. The input shapes mirror rules.js's zod schema, which
   has the last word (it also checks that a calendar rule has keywords and a
   routine rule a category). */

const TRIGGER_SHAPE = z.object({
  sources: z.array(z.enum(['calendar', 'routine'])).min(1)
    .describe('Odkud: "calendar" (události v kalendáři), "routine" (bloky týdenní rutiny), nebo obojí.'),
  calendar_match: z.array(z.string()).optional()
    .describe('Klíčová slova v názvu události (bez ohledu na diakritiku a velikost). Slova od 5 písmen chytají i skloňování ("posilovna" → "posilovnu"), kratší jen přesně ("run").'),
  routine_category: z.enum(CATEGORIES).optional().describe('Kategorie bloku rutiny.'),
  routine_note_match: z.array(z.string()).optional().describe('Jen bloky, jejichž poznámka obsahuje některé z těchto slov.'),
  starts_before: z.string().optional().describe('Jen když událost/blok začíná před "HH:MM".'),
});

const TIMING_SHAPE = z.object({
  anchor: z.enum(['evening_before', 'morning_of', 'before_start'])
    .describe('evening_before = večer předem, morning_of = ráno toho dne, before_start = X minut před začátkem.'),
  at: z.string().optional().describe('Čas "HH:MM" pro evening_before (výchozí 20:00) a morning_of (výchozí 07:00).'),
  offset_min: z.number().int().min(0).max(1440).optional().describe('Minuty před začátkem pro before_start (výchozí 60).'),
});

const TASK_SHAPE = z.object({
  label: z.string().describe('Text úkolu, který pravidlo vytvoří.'),
  meta: z.string().optional().describe('Doplněk k úkolu.'),
  duration_min: z.number().int().min(5).max(1440).optional().describe('Délka v minutách (úkol má čas, ukáže se v kalendáři).'),
  checklist: z.array(z.string()).optional().describe('Položky seznamu, který se k úkolu založí.'),
});

function previewLines(rule, days = 7) {
  const from = new Date();
  let items;
  try {
    items = nightstore.previewWindow({ from, to: new Date(from.getTime() + days * 86400000), now: from, rules: [rule] });
  } catch (err) {
    return `(náhled nejde spočítat: ${err.message})`;
  }
  // An exact calendar × routine pair is merged into the calendar one.
  items = items.filter((i) => !(i.source === 'routine' && i.overlap && i.overlap.exact));
  return items.length
    ? items.map((i) => '- ' + describeItem(i)).join('\n')
    : `(v příštích ${days} dnech by nevytvořilo nic — zkontroluj klíčová slova proti tomu, jak se události v kalendáři opravdu jmenují)`;
}

function describeFull(rule) {
  return `${describeRule(rule)}${rule.enabled === false ? ' [vypnuto]' : ''}\n    spouští: ${describeTrigger(rule.trigger)}; kdy: ${describeTiming(rule.timing)}` +
    (rule.task.checklist && rule.task.checklist.length ? `; seznam: ${rule.task.checklist.join(', ')}` : '') +
    (rule.invalid ? `\n    NEPLATNÉ: ${rule.invalid}` : '');
}

const rulesList = tool(
  'rules_list',
  'Vypiš pravidla nočního plánování: sady pravidel a v nich pravidla (co je spouští, kdy a jaký úkol vytvoří). ' +
    'Zavolej před úpravou pravidla, ať znáš id.',
  {},
  async () => {
    const sets = nightstore.listRulesets();
    if (!sets.length) return ok('Žádná pravidla.');
    return ok(sets.map((s) =>
      `SADA (${s.id}) „${s.name}“${s.enabled ? '' : ' [vypnutá]'}:\n` +
      (s.rules.length ? s.rules.map((r) => `  - (${r.id}) ${describeFull(r)}`).join('\n') : '  (prázdná)'),
    ).join('\n\n'));
  },
);

const rulesetUpsert = tool(
  'ruleset_upsert',
  'Založ novou sadu pravidel, nebo stávající přejmenuj / zapni / vypni (vypnutá sada = žádné její pravidlo neběží, např. na dovolenou).',
  {
    id: z.string().optional().describe('Id sady z rules_list; vynech = nová sada.'),
    name: z.string().optional().describe('Název sady.'),
    enabled: z.boolean().optional().describe('Zapnuto / vypnuto.'),
    description: z.string().optional(),
  },
  async (args) => {
    try {
      const set = nightstore.upsertRuleset(args);
      onWrite('rules');
      return ok(`Sada „${set.name}“ (${set.id}) ${set.enabled ? 'zapnutá' : 'vypnutá'}, ${set.rules.length} pravidel.`);
    } catch (err) {
      return fail(`${err.message}. Nic se nezměnilo.`);
    }
  },
);

const ruleUpsert = tool(
  'rule_upsert',
  'Vytvoř nebo změň pravidlo nočního plánování: když je v kalendáři nebo v rutině něco, vytvoř úkol v daný čas. ' +
    'Pro stálé vzorce ("kdykoli mám posilovnu, připomeň mi večer předem sbalit tašku") — ne pro jednorázové úkoly. ' +
    'Vrátí náhled toho, co by pravidlo vytvořilo v příštích 7 dnech.',
  {
    id: z.string().optional().describe('Id pravidla z rules_list; vynech = nové pravidlo.'),
    ruleset_id: z.string().optional().describe('Do které sady; vynech = první sada.'),
    name: z.string().optional().describe('Krátký název, např. "Posilovna".'),
    enabled: z.boolean().optional(),
    trigger: TRIGGER_SHAPE.optional(),
    timing: TIMING_SHAPE.optional(),
    task: TASK_SHAPE.optional(),
  },
  async (args) => {
    let result;
    try {
      result = nightstore.upsertRule(args);
    } catch (err) {
      return fail(`Pravidlo neuloženo: ${err.message}. Nic se nezměnilo.`);
    }
    onWrite('rules');
    return ok(
      `${result.before ? 'Upraveno' : 'Vytvořeno'}: (${result.rule.id}) ${describeFull(result.rule)}\n\n` +
      `V příštích 7 dnech by vytvořilo:\n${previewLines(result.rule)}`,
    );
  },
);

const ruleDelete = tool(
  'rule_delete',
  'Smaž pravidlo nočního plánování. Úkoly, které už vytvořilo, zůstanou.',
  { id: z.string().describe('Id pravidla z rules_list.') },
  async ({ id }) => {
    try {
      const before = nightstore.deleteRule(id);
      onWrite('rules');
      return ok(`Smazáno pravidlo „${before.name}“.`);
    } catch (err) {
      return fail(`${err.message}. Nic se nezměnilo.`);
    }
  },
);

const rulePreview = tool(
  'rule_preview',
  'Ukaž, co by pravidlo vytvořilo v příštích dnech — uložené (id), nebo návrh ještě před uložením (name, trigger, timing, task).',
  {
    id: z.string().optional().describe('Id uloženého pravidla.'),
    name: z.string().optional(),
    trigger: TRIGGER_SHAPE.optional(),
    timing: TIMING_SHAPE.optional(),
    task: TASK_SHAPE.optional(),
    days: z.number().int().min(1).max(31).optional().describe('Kolik dní dopředu (výchozí 7).'),
  },
  async ({ id, days, ...draft }) => {
    let rule;
    if (id) {
      rule = nightstore.getRule(id);
      if (!rule) return fail(`Pravidlo "${id}" neexistuje. Vypiš si je přes rules_list.`);
    } else {
      const parsed = RuleSchema.safeParse({ name: draft.name || 'Návrh', ...draft });
      if (!parsed.success) return fail(`Návrh nedává smysl: ${explainIssues(parsed.error)}`);
      rule = { id: 'draft', ...parsed.data };
    }
    return ok(`${describeRule(rule)}\n\nV příštích ${days || 7} dnech:\n${previewLines(rule, days || 7)}`);
  },
);

/* ---- unsure calendar events ---------------------------------------------
   klaus_memory's calendar has no "maybe", so Kacey keeps it (eventflags.js).
   The name says "calendar" on purpose: protocol.js refreshes the calendar
   view after any tool whose name does. */

function describeUnsure(e) {
  // Local time: the calendar stores UTC ("…+00:00"), and she says the hour aloud.
  const d = new Date(e.starts_at);
  const when = isNaN(d) ? String(e.starts_at || '')
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `- (${e.event_id}) ${e.title || '(bez názvu)'} — ${when}${e.source ? ` · ${e.source}` : ''}${e.note ? ` · ${e.note}` : ''}`;
}

const calendarTentative = tool(
  'app_calendar_tentative',
  'Nejisté události v kalendáři. action "mark" označí existující událost jako nejistou ' +
  '(„?“, „možná“, „k rozhodnutí“, plakát, na který pán možná půjde) — v kalendáři je pak ' +
  'čárkovaně. Událost nejdřív založ přes calendar_create a id vezmi z výsledku. ' +
  '"confirm" z ní udělá běžnou (pán jde / je to jisté). "list" vypíše všechny nejisté. ' +
  'Nejistá zůstane jen v Kacey — Google ani TimeTree ji neoznačí.',
  {
    action: z.enum(['mark', 'confirm', 'list']),
    event_id: z.string().optional().describe('Id události (ev_…) pro mark a confirm.'),
    note: z.string().max(300).optional().describe('Na čem to záleží, např. "podle počasí" nebo "zeptat se Petra".'),
  },
  async ({ action, event_id, note }) => {
    try {
      if (action === 'list') {
        const rows = eventflags.listTentative();
        return ok(rows.length ? `Nejisté události:\n${rows.map(describeUnsure).join('\n')}` : 'Žádné nejisté události.');
      }
      if (!event_id) return fail('Chybí event_id. Nic se nezměnilo.');
      const ev = eventflags.setTentative(event_id, action === 'mark', note || '');
      return ok(action === 'mark'
        ? `Označeno jako nejisté: ${describeUnsure({ ...ev, note })}`
        : `Potvrzeno, už není nejisté: ${describeUnsure(ev)}`);
    } catch (err) {
      return fail(`${err.message}. Nic se nezměnilo.`);
    }
  },
);

/* The phone's notifications (notifications.js), read only — except marking
   them read, which is what "díky, to stačí" after a readout means. Sensitive
   rows (login codes, secret notifications) come back without their text. */
const notificationsRead = tool(
  'app_notifications',
  'Oznámení z pánova telefonu (přeposílá je aplikace Kacey na Androidu). ' +
  '"unread" = co je nepřečtené, ze všech aplikací. "apps" = přehled po aplikacích. ' +
  '"dm" = konverzace ze soukromých zpráv Instagramu; s conversation vrátí celé vlákno. ' +
  '"mark_read" označí jako přečtené (s conversation jen to vlákno, s app_package jen tu aplikaci, ' +
  'bez nich všechno) — jen když to pán chce nebo když jsi mu je právě přečetla. ' +
  'Nečti zprávy doslova, pokud o to pán nepožádá; řekni kdo píše a o co jde.',
  {
    action: z.enum(['unread', 'apps', 'dm', 'mark_read']),
    conversation: z.string().max(300).optional().describe('Název vlákna (jméno nebo skupina), jak ho vrátil "dm".'),
    app_package: z.string().max(200).optional().describe('Balíček aplikace, např. "com.instagram.android".'),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ action, conversation, app_package, limit }) => {
    try {
      if (action === 'apps') {
        const rows = notifications.apps();
        return ok(rows.length
          ? rows.map((a) => `- ${a.app} (${a.package}): ${a.unread} nepřečtených z ${a.total}, poslední ${a.last_at.slice(0, 16)}`).join('\n')
          : 'Z telefonu zatím žádná oznámení nepřišla.');
      }
      if (action === 'unread') {
        const rows = notifications.list({ unread: true, package: app_package, limit: limit || 60 });
        return ok(rows.length ? `Nepřečtené (${rows.length}), nejnovější nahoře:\n${rows.map(notifications.describe).join('\n')}` : 'Nic nepřečteného.');
      }
      if (action === 'dm') {
        const pkg = app_package || notifications.INSTAGRAM;
        if (conversation) {
          const rows = notifications.thread(pkg, conversation, { limit: limit || 60 });
          return ok(rows.length ? `Vlákno „${conversation}“, nejstarší nahoře:\n${rows.map(notifications.describe).join('\n')}` : `Vlákno „${conversation}“ neznám.`);
        }
        const rows = notifications.threads(pkg, { limit: limit || 30 });
        return ok(rows.length
          ? rows.map((t) => `- „${t.conversation}“${t.group ? ' (skupina)' : ''}: ${t.unread} nepřečtených, poslední ${notifications.describe(t.last).slice(2)}`).join('\n')
          : 'Žádné zprávy z Instagramu.');
      }
      const changed = notifications.markRead(conversation || app_package
        ? { package: app_package || notifications.INSTAGRAM, conversation }
        : { all: true });
      return ok(`Označeno jako přečtené: ${changed}.`);
    } catch (err) {
      return fail(`${err.message}. Nic se nezměnilo.`);
    }
  },
);

/* ---- the morning checklist -------------------------------------------------- */

function nextDay(date) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const morningAdd = tool(
  'app_morning_add',
  'Přidej položku do ranního checklistu (ranní obrazovka u postele). Bez `once` platí každé ráno ' +
    'od příštího; s `once: true` jen na jedno, nejbližší ráno ("jen zítra"). Úkoly s termínem patří ' +
    'do app_task_add, ne sem — sem jen to, co se dělá hned po probuzení.',
  {
    label: z.string().max(80).describe('Co udělat ráno, krátce: "Vzít léky", "Zalít kytky".'),
    once: z.boolean().optional().describe('true = jen na příští ráno, pak zmizí.'),
  },
  async ({ label, once }) => {
    const text = String(label || '').trim();
    if (!text) return fail('Prázdná položka.');
    const before = appstate.morningChecklist();
    const list = { items: before.items.slice(), once: before.once.slice() };
    const now = new Date();
    if (once) {
      if (list.once.length >= MAX_ITEMS) return fail('Jednorázových položek je už moc. Nic se nepřidalo.');
      const date = nextDay(logicalDateOf(now));
      const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      list.once.push({ key: newKey(), label: text, date, note: `Kacey přidala v ${hm} z konverzace` });
      appstate.setSection('morning', list);
      onWrite('morning', before);
      return ok(`Přidáno jen na ráno ${date}: ${text}`);
    }
    if (list.items.length >= MAX_ITEMS) return fail(`Checklist má už ${MAX_ITEMS} položek. Nic se nepřidalo.`);
    list.items.push({ key: newKey(), label: text });
    appstate.setSection('morning', list);
    onWrite('morning', before);
    return ok(`Přidáno do ranního checklistu, platí od příštího rána: ${text}`);
  },
);

/* ---- improving the app itself (selfupdate.js) ---------------------------- */

/* Kacey cannot change her own code; this hands the request to selfupdate.js,
   which shows the owner a popup (confirmation, or up to three questions) and,
   once confirmed, has a coding agent draft it on a kaceyFeature/ branch.
   server.js registers the handler (setUpgradeHandler) only where the feature
   is on, so a preview never offers it. */
let onUpgrade = null;
export function setUpgradeHandler(fn) { onUpgrade = typeof fn === 'function' ? fn : null; }

const VIEW_NAMES = ['main', 'tasks', 'calendar', 'journal', 'library', 'gallery', 'brief', 'timer', 'controller', 'rules', 'morning', 'lights'];

function makeUpgradeRequest(ctx) {
  return tool(
    'app_upgrade_request',
    'Pán chce NOVOU FUNKCI nebo ZMĚNU APLIKACE samotné (obrazovky, ovládání, chování Kacey jako programu) — ' +
      '„přidej funkci…“, „chci, aby úkoly šly třídit…“, „předělej kalendář…“. Neslouží pro data (přidat úkol, ' +
      'změnit rutinu, zapsat do deníku) — na ta máš jiné nástroje. Otevře pánovi okno se zadáním; po potvrzení ' +
      'změnu navrhne programátorský agent na vlastní větvi a pán ji porovná vedle běžící verze. ' +
      'Otázky (questions) přidej jen tehdy, když rozsah nejde rozumně odhadnout — nejvýš tři, každá s výchozí volbou.',
    {
      title: z.string().min(3).max(80).describe('Název vylepšení česky, „Oblast — co“: "Úkoly — třídění podle skupin"'),
      short: z.string().min(3).max(40).describe('Krátký název do čipu a karty: "Úkoly — skupiny"'),
      slug: z.string().min(2).max(40).describe('ASCII pro název větve: "ukoly-skupiny"'),
      request: z.string().min(3).max(1000).describe('Co pán řekl, jeho slovy'),
      bullets: z.array(z.string().min(3).max(120)).min(1).max(5).describe('„Co navrhnu“ — 2–4 konkrétní body'),
      area: z.string().min(2).max(120).describe('Kde se to projeví: "Úkoly · Dnešní úkoly na domovské"'),
      platforms: z.array(z.enum(['desktop', 'telefon'])).min(1).max(2),
      view: z.enum(VIEW_NAMES).describe('Obrazovka, na které je změna nejlíp vidět (porovnání se otevře na ní)'),
      questions: z.array(z.object({
        title: z.string().min(3).max(100).describe('Otázka: "Jak vznikají skupiny?"'),
        key: z.string().min(2).max(24).describe('Krátký popisek do shrnutí: "Skupiny"'),
        multi: z.boolean().describe('Jde vybrat víc možností'),
        options: z.array(z.string().min(1).max(60)).min(2).max(5),
        default: z.array(z.number().int().min(0).max(4)).min(1).max(5).describe('Index(y) výchozí volby'),
      })).max(3).optional(),
    },
    async (args) => {
      if (!onUpgrade) return ok('Vylepšování aplikace tu není zapnuté. Řekni to pánovi jednou větou.');
      const r = onUpgrade(args, ctx?.sessionId?.() || null);
      return ok(r.text);
    },
  );
}

/* ---- the photo gallery ---------------------------------------------------- */

/* Both need the session: the save takes the picture the owner sent in the
   chat (`ctx.images()`), and both show the photos in that chat (`ctx.send`)
   as a `gallery` frame the page draws under Kacey's words. */

function makeGallerySave(ctx) {
  return tool(
    'app_gallery_save',
    'Uloží fotku, kterou pán poslal do chatu, do jeho Galerie na serveru — „ulož mi tuto fotku“, „dej to do galerie“. ' +
      'Fotku vidíš, takže popis napíšeš ty: title (2–6 slov), caption (1–2 věty, co je na ní; neodhaduj, kdo jsou lidé), ' +
      'tags (3–8 štítků malými písmeny) a keywords (10–25 slov pro hledání: nadřazené pojmy, synonyma, barvy, místo, text na fotce). ' +
      'Pán popisky neupravuje, tak ať sedí. Poslal-li víc obrázků a neřekl který, ulož všechny (volej nástroj pro každý).',
    {
      image: z.number().int().min(1).max(4).optional().describe('Kolikátý obrázek z poslední zprávy s obrázky (od 1). Výchozí 1.'),
      title: z.string().min(2).max(80),
      caption: z.string().min(3).max(400),
      tags: z.array(z.string().min(1).max(30)).min(1).max(8),
      keywords: z.array(z.string().min(1).max(40)).max(25).optional(),
    },
    async ({ image = 1, title, caption, tags, keywords }) => {
      const list = ctx?.images?.() || [];
      const img = list[image - 1];
      if (!img) return fail('V téhle konverzaci žádnou fotku nemám — popros pána, ať ji pošle (sponka nebo vložit).');
      try {
        const photo = await gallery.save({ image: img, source: 'chat', meta: { title, caption, tags, keywords } });
        if (photo.status !== 'ready') return ok('Uloženo do Galerie, ale tvůj popis se nepoužil — popis a štítky dopíše galerie sama za chvilku.');
        ctx?.send?.({ type: 'gallery', event: 'saved_chat', photo });
        return ok(`Uloženo do Galerie: ${gallery.describeForModel(photo)}`);
      } catch (err) {
        return fail(`Neuloženo: ${err.message}`);
      }
    },
  );
}

function makeGallerySearch(ctx) {
  return tool(
    'app_gallery_search',
    'Hledá v pánově Galerii fotek podle významu („fotka psa z chalupy“, „účtenka z Alzy“, „ty západy slunce z léta“) ' +
      'nebo podle štítku. Vrátí nejpodobnější fotky s datem, popisem a štítky; pánovi se zároveň ukážou náhledy v chatu, ' +
      'takže je nevypisuj všechny — řekni, co jsi našla, a zmiň nejlepší shodu.',
    {
      query: z.string().max(300).describe('Co hledá, jeho slovy. Prázdné = nejnovější fotky.'),
      tag: z.string().max(60).optional().describe('Jen fotky s tímto štítkem.'),
      limit: z.number().int().min(1).max(12).optional(),
    },
    async ({ query: q, tag, limit = 6 }) => {
      let r;
      try { r = await gallery.list({ q, tag: tag || '', limit }); } catch (err) {
        return fail(`Galerii se nepodařilo prohledat: ${err.message}`);
      }
      const ready = r.photos.filter((p) => p.status === 'ready');
      ctx?.send?.({ type: 'gallery', event: 'hits', query: q, tag: tag || '', photos: ready });
      if (!r.total) return ok('Galerie je zatím prázdná.');
      if (!ready.length) return ok(`Nic podobného jsem nenašla (v galerii je ${r.total} fotek).`);
      return ok(`${ready.length} fotek (z ${r.total}), nejpodobnější první:\n` + ready.map(gallery.describeForModel).join('\n'));
    },
  );
}

/* ---- the server --------------------------------------------------------- */

export const APP_TOOLS = [
  appRead, routinePaint, routineErase, routineHours, routineAlter, taskAdd, taskUpdate, taskTags, journalAdd,
  rulesList, rulesetUpsert, ruleUpsert, ruleDelete, rulePreview, calendarTentative,
  notificationsRead, morningAdd,
];

/** Fully-qualified names, for the allow-list in server.js. */
export const APP_TOOL_NAMES = [
  'app_read', 'app_routine_paint', 'app_routine_erase', 'app_routine_hours', 'app_routine_alter',
  'app_task_add', 'app_task_update', 'app_task_tags', 'app_journal_add',
  'rules_list', 'ruleset_upsert', 'rule_upsert', 'rule_delete', 'rule_preview',
  'app_calendar_tentative', 'app_notifications', 'app_morning_add', 'app_upgrade_request',
  'app_gallery_save', 'app_gallery_search',
].map((n) => `mcp__${APP_SERVER_NAME}__${n}`);

/** `ctx.sessionId()` names the chat that asks for an improvement (the history marks it). */
export function makeAppServer(ctx = {}) {
  return createSdkMcpServer({
    name: APP_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Nástroje pro úpravu Kaceyiny vlastní aplikace: týdenní rutina, úkoly (každý se štítkem, ' +
      'štítky samotné upravuje app_task_tags), deník, ' +
      'a pravidla nočního plánování (rules_*, rule_*), podle kterých se v noci samy zakládají úkoly. ' +
      'Nejisté události kalendáře označuje app_calendar_tentative. ' +
      'Oznámení z telefonu a zprávy z Instagramu čte app_notifications. ' +
      'Rutina je tvar běžného týdne (opakující se bloky), NE konkrétní události — ' +
      'ty patří do kalendáře přes klaus-memory. Změna jen pro konkrétní den (nemoc, zrušený nebo posunutý trénink) ' +
      'je app_routine_alter, ne app_routine_paint — výchozí týden zůstane. Před úpravou si přečti stav přes app_read. ' +
      'Když uživatel pošle obrázek rozvrhu, přečti ho a natři přes app_routine_paint ' +
      's replace: true; u každé hodiny vyplň note (předmět), room (místnost) a who (vyučující). ' +
      'Novou funkci nebo změnu aplikace samotné předáš přes app_upgrade_request. ' +
      'Fotku z chatu uložíš do pánovy Galerie přes app_gallery_save (popis a štítky píšeš ty); ' +
      'na staré fotky se ptá app_gallery_search.',
    tools: [...APP_TOOLS, makeUpgradeRequest(ctx), ...makeGalleryTools(ctx)],
  });
}

/** The two gallery tools for one session (tests call them directly). */
export function makeGalleryTools(ctx = {}) {
  return [makeGallerySave(ctx), makeGallerySearch(ctx)];
}
