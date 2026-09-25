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
import { CATEGORY_KEYS } from './public/js/core/routine-cats.js';
import * as nightstore from './nightstore.js';
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
function describeTask(t) {
  const when = t.due_at
    ? `${t.due_at} (${dueLabel(t.due_at)}${t.duration ? `, ${t.duration} min` : ''}) — ${BUCKET_WORDS[bucketOf(t)]}`
    : BUCKET_WORDS.none;
  return `- [${t.done ? 'x' : ' '}] (${t.id}) ${t.label} — ${when}${t.meta ? ` · ${t.meta}` : ''}`;
}

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
      return `${hhmm(b.i * 15)}-${hhmm((b.i + b.n) * 15)} ${b.cat}${note ? ` "${note}"` : ''}`;
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
    }
    if (section === 'all' || section === 'tasks') {
      parts.push('TASKS:\n' + (doc.tasks.length
        ? doc.tasks.map(describeTask).join('\n')
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
      note: z.string().optional().describe('Volitelný popisek bloku, např. "Laborka".'),
    })).describe('Bloky k natření.'),
    replace: z.boolean().optional()
      .describe('true = nejdřív smaž celou stávající rutinu (import celého rozvrhu). ' +
                'false/vynecháno = jen přimaluj k tomu, co tam je.'),
  },
  async ({ blocks, replace }) => {
    const doc = appstate.get();
    const before = { grid: { ...doc.routine.grid }, notes: { ...doc.routine.notes } };

    const grid = replace ? {} : { ...doc.routine.grid };
    const notes = replace ? {} : { ...doc.routine.notes };

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

    appstate.setSection('routine', { ...doc.routine, grid, notes });
    onWrite('routine', { ...doc.routine, ...before });

    const hours = Math.round(painted / 4 * 10) / 10;
    return ok(
      `Natřeno ${painted} patnáctiminutových bloků (${hours} h)` +
      (replace ? ', stará rutina smazána' : '') + '.' +
      (skipped.length ? ` Přeskočeno ${skipped.length} slotů ve spánku (${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}) — když je potřebuješ, posuň vstávání/spánek přes app_routine_hours.` : '') +
      '\n\nNový stav:\n' + describeRoutine({ grid, notes }),
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
    const before = { grid: { ...doc.routine.grid }, notes: { ...doc.routine.notes } };

    if (all) {
      appstate.setSection('routine', { ...doc.routine, grid: {}, notes: {} });
      onWrite('routine', { ...doc.routine, ...before });
      return ok('Celá rutina smazána.');
    }

    if (!days || !days.length || !from || !to) {
      return fail('Buď "all": true, nebo days + from + to. Nic se nezměnilo.');
    }

    const grid = { ...doc.routine.grid };
    const notes = { ...doc.routine.notes };
    let removed = 0;
    try {
      const f = minutesOf(from), t = minutesOf(to);
      for (const day of days) {
        const d = dayIndex(day);
        for (let m = Math.floor(f / 15) * 15; m < t; m += 15) {
          const key = d + '-' + (m / 15);
          if (key in grid) { delete grid[key]; removed++; }
          delete notes[key];
        }
      }
    } catch (err) {
      return fail(`Nesmazáno: ${err.message}. Nic se nezměnilo.`);
    }

    appstate.setSection('routine', { ...doc.routine, grid, notes });
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

const taskAdd = tool(
  'app_task_add',
  'Přidej úkol do seznamu v aplikaci. Skupiny (po termínu, dnes, tento týden) ' +
    'se počítají z termínu samy — nastav termín, ne skupinu.',
  {
    label: z.string().describe('Co je potřeba udělat.'),
    due: z.string().optional().describe(DUE_HELP + ' Vynech = bez termínu.'),
    duration: z.number().int().min(5).max(1440).optional()
      .describe('Jen pro úkol s časem: kolik minut zabere (výchozí 30). Tak dlouhý blok bude v kalendáři.'),
    meta: z.string().optional().describe('Doplněk: kontext, štítek. Termín sem nepiš.'),
  },
  async ({ label, due, duration, meta }) => {
    const text = String(label || '').trim();
    if (!text) return fail('Prázdný úkol.');

    let dueAt;
    try { dueAt = normalizeDue(due); } catch (err) { return fail(err.message + ' Nic se nepřidalo.'); }

    const doc = appstate.get();
    const before = doc.tasks.slice();
    const task = {
      id: 't' + Date.now(),
      label: text,
      meta: meta || 'přidala Kacey',
      done: false,
      due_at: dueAt,
      ...(duration && parseDue(dueAt)?.time ? { duration } : {}),
    };
    appstate.setSection('tasks', doc.tasks.concat([task]));
    onWrite('tasks', before);
    return ok(`Přidáno: ${describeTask(task).slice(2)}`);
  },
);

const taskUpdate = tool(
  'app_task_update',
  'Změň úkol — odškrtni ho, přejmenuj, změň nebo zruš termín, nebo smaž. ' +
    'Id zjistíš z app_read.',
  {
    id: z.string().describe('Id úkolu z app_read.'),
    done: z.boolean().optional().describe('true = hotovo, false = zpět na nehotovo.'),
    label: z.string().optional().describe('Nový text úkolu.'),
    due: z.string().nullable().optional().describe(DUE_HELP + ' null = termín zrušit.'),
    duration: z.number().int().min(5).max(1440).optional().describe('Nová délka v minutách (jen úkol s časem).'),
    remove: z.boolean().optional().describe('true = úkol smaž.'),
  },
  async ({ id, done, label, due, duration, remove }) => {
    const doc = appstate.get();
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) return fail(`Úkol "${id}" neexistuje. Vypiš si je přes app_read.`);

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
    } : t));
    appstate.setSection('tasks', next);
    onWrite('tasks', before);

    return ok(`Upraveno: ${describeTask(appstate.get().tasks.find((t) => t.id === id)).slice(2)}`);
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

/* ---- the server --------------------------------------------------------- */

export const APP_TOOLS = [
  appRead, routinePaint, routineErase, routineHours, taskAdd, taskUpdate, journalAdd,
  rulesList, rulesetUpsert, ruleUpsert, ruleDelete, rulePreview,
];

/** Fully-qualified names, for the allow-list in server.js. */
export const APP_TOOL_NAMES = [
  'app_read', 'app_routine_paint', 'app_routine_erase', 'app_routine_hours',
  'app_task_add', 'app_task_update', 'app_journal_add',
  'rules_list', 'ruleset_upsert', 'rule_upsert', 'rule_delete', 'rule_preview',
].map((n) => `mcp__${APP_SERVER_NAME}__${n}`);

export function makeAppServer() {
  return createSdkMcpServer({
    name: APP_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Nástroje pro úpravu Kaceyiny vlastní aplikace: týdenní rutina, úkoly, deník, ' +
      'a pravidla nočního plánování (rules_*, rule_*), podle kterých se v noci samy zakládají úkoly. ' +
      'Rutina je tvar běžného týdne (opakující se bloky), NE konkrétní události — ' +
      'ty patří do kalendáře přes klaus-memory. Před úpravou si přečti stav přes app_read. ' +
      'Když uživatel pošle obrázek rozvrhu, přečti ho a natři přes app_routine_paint ' +
      's replace: true.',
    tools: APP_TOOLS,
  });
}
