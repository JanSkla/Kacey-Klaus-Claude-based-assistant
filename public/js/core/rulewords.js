/* =========================================================================
   How a night-planning rule reads in one line — shared by the browser and
   the server (Claude Design "Kacey Night and Morning" 3a, 2c, 5a).

   The line leads with what sets the rule off, not with its name:
     "Posilovna → večer předem 20:00 → Sbalit tašku"
     "Rutina Pohyb „běh“ → ráno v den 06:45 → …"
   The rules list, the proposal's "make it a rule" offer, a task's reason and
   Kacey's own tools (rules.js describeRule) all say it the same way.

   ES5 and no DOM, like due.js. CATS comes from routine-cats.js.
   ========================================================================= */

import { CATS } from './routine-cats.js';

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/** "Posilovna" (the first calendar keyword), or "Rutina Pohyb „běh“". */
export function triggerShort(trigger) {
  var t = trigger || {};
  var sources = t.sources || [];
  if (sources.indexOf('calendar') !== -1) {
    var kw = (t.calendar_match || [])[0];
    return kw ? cap(String(kw)) : 'Kalendář';
  }
  if (sources.indexOf('routine') !== -1) {
    var cat = CATS[t.routine_category] ? CATS[t.routine_category].label : (t.routine_category || '');
    var note = (t.routine_note_match || [])[0];
    return 'Rutina ' + cat + (note ? ' „' + note + '“' : '');
  }
  return 'Pravidlo';
}

/** "večer předem 20:00", "ráno v den 07:00", "45 min před". */
export function timingShort(timing) {
  var tm = timing || {};
  if (tm.anchor === 'evening_before') return 'večer předem ' + (tm.at || '20:00');
  if (tm.anchor === 'morning_of') return 'ráno v den ' + (tm.at || '07:00');
  return (tm.offset_min == null ? 60 : tm.offset_min) + ' min před';
}

/** "Posilovna → večer předem 20:00 → Sbalit tašku" ("…" while the task has no name). */
export function ruleSummary(rule) {
  var label = rule && rule.task && rule.task.label;
  return triggerShort(rule && rule.trigger) + ' → ' + timingShort(rule && rule.timing) + ' → ' + (label || '…');
}

/** "Pravidlo Posilovna · Pohyb → ráno v den 07:00": where a rule-made task came from. */
export function ruleOrigin(rule, setName) {
  var trig = triggerShort(rule && rule.trigger).replace(/^Rutina /, '');
  return 'Pravidlo ' + (setName || (rule && rule.name) || '') + ' · ' + trig + ' → ' + timingShort(rule && rule.timing);
}
