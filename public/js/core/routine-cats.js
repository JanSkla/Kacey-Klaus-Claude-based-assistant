/* =========================================================================
   The routine's categories — shared by the browser and the server.

   The weekly planner paints with these, the calendar lane draws them, Kacey's
   tools paint with them, and the night routine's rules trigger on them
   (docs/DREAM.md §8). One list, so a new category cannot exist in one place
   and be refused in another.

   No DOM here, and no imports: server-side modules load this file as it is,
   like due.js. The colours are data, not tokens (DESIGN.md §2).
   ========================================================================= */

export var CATS = {
  routine: { label: 'Rutina', color: '#d2a106' },
  gym:     { label: 'Pohyb',  color: '#ee5396' },
  work:    { label: 'Práce',  color: '#009d9a' },
  study:   { label: 'Studium', color: '#a56eff' },
  free:    { label: 'Volno',  color: '#24a148' },
  commute: { label: 'Cesta',  color: '#8d8d8d' }
};

export var CATEGORY_KEYS = Object.keys(CATS);

/* A class's type, for a block from a school timetable: a tag at the top of the
   block's edge in the calendar (Claude Design "Kacey Desktop" / DayTimeline).
   Light tints, so they read against any category colour. */
export var KINDS = {
  pr:  { label: 'přednáška', color: '#fddc69', word: 'žlutá' },
  cv:  { label: 'cvičení',   color: '#a7f0ba', word: 'zelená' },
  lab: { label: 'laboratoř', color: '#a6c8ff', word: 'modrá' }
};

export var KIND_KEYS = Object.keys(KINDS);
