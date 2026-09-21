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

export const APP_SERVER_NAME = 'kacey-app';

/* The routine's categories, and the days, exactly as the browser knows them.
   Kept in step with public/js/views/routine.js by hand — there are six of them
   and they have not changed in the life of the project. */
const CATEGORIES = ['routine', 'gym', 'work', 'study', 'free', 'commute'];
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
        ? doc.tasks.map((t) => `- [${t.done ? 'x' : ' '}] (${t.id}) ${t.label} — ${t.group}${t.meta ? ` · ${t.meta}` : ''}`).join('\n')
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
      category: z.enum(['routine', 'gym', 'work', 'study', 'free', 'commute'])
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
  'Přidej úkol do seznamu v aplikaci.',
  {
    label: z.string().describe('Co je potřeba udělat.'),
    group: z.enum(['overdue', 'today', 'week']).optional()
      .describe('Kam patří. Výchozí "today".'),
    meta: z.string().optional().describe('Doplněk: termín, kontext, štítek.'),
  },
  async ({ label, group, meta }) => {
    const text = String(label || '').trim();
    if (!text) return fail('Prázdný úkol.');

    const doc = appstate.get();
    const before = doc.tasks.slice();
    const task = {
      id: 't' + Date.now(),
      label: text,
      meta: meta || 'přidala Kacey',
      group: group || 'today',
      done: false,
      today: (group || 'today') !== 'week',
    };
    appstate.setSection('tasks', doc.tasks.concat([task]));
    onWrite('tasks', before);
    return ok(`Přidáno: "${text}" (${task.group}, id ${task.id}).`);
  },
);

const taskUpdate = tool(
  'app_task_update',
  'Změň úkol — odškrtni ho, přejmenuj, přesuň do jiné skupiny, nebo smaž. ' +
    'Id zjistíš z app_read.',
  {
    id: z.string().describe('Id úkolu z app_read.'),
    done: z.boolean().optional().describe('true = hotovo, false = zpět na nehotovo.'),
    label: z.string().optional().describe('Nový text úkolu.'),
    group: z.enum(['overdue', 'today', 'week']).optional().describe('Nová skupina.'),
    remove: z.boolean().optional().describe('true = úkol smaž.'),
  },
  async ({ id, done, label, group, remove }) => {
    const doc = appstate.get();
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) return fail(`Úkol "${id}" neexistuje. Vypiš si je přes app_read.`);

    const before = doc.tasks.slice();

    if (remove) {
      appstate.setSection('tasks', doc.tasks.filter((t) => t.id !== id));
      onWrite('tasks', before);
      return ok(`Smazáno: "${task.label}".`);
    }

    const next = doc.tasks.map((t) => (t.id === id ? {
      ...t,
      ...(done === undefined ? {} : { done }),
      ...(label ? { label } : {}),
      ...(group ? { group, today: group !== 'week' } : {}),
    } : t));
    appstate.setSection('tasks', next);
    onWrite('tasks', before);

    const now = next.find((t) => t.id === id);
    return ok(`Upraveno: "${now.label}" — ${now.done ? 'hotovo' : 'nehotovo'}, ${now.group}.`);
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

/* ---- the server --------------------------------------------------------- */

export const APP_TOOLS = [
  appRead, routinePaint, routineErase, routineHours, taskAdd, taskUpdate, journalAdd,
];

/** Fully-qualified names, for the allow-list in server.js. */
export const APP_TOOL_NAMES = [
  'app_read', 'app_routine_paint', 'app_routine_erase', 'app_routine_hours',
  'app_task_add', 'app_task_update', 'app_journal_add',
].map((n) => `mcp__${APP_SERVER_NAME}__${n}`);

export function makeAppServer() {
  return createSdkMcpServer({
    name: APP_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Nástroje pro úpravu Kaceyiny vlastní aplikace: týdenní rutina, úkoly, deník. ' +
      'Rutina je tvar běžného týdne (opakující se bloky), NE konkrétní události — ' +
      'ty patří do kalendáře přes klaus-memory. Před úpravou si přečti stav přes app_read. ' +
      'Když uživatel pošle obrázek rozvrhu, přečti ho a natři přes app_routine_paint ' +
      's replace: true.',
    tools: APP_TOOLS,
  });
}
