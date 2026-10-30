/* =========================================================================
   Hlasitost Kacey — how loud her own voice is, 0–100 % — shared by the
   browser and the server.

   Stored in settings.ttsVolume (with ttsVolumeBy 'owner' | 'kacey' and
   ttsVolumeAt), but written only through its own door: PUT /api/voice/volume
   from the Controller, appstate.setVoiceVolume() from Kacey's
   app_voice_volume. A whole-settings save keeps the stored value, so a page
   that went stale cannot put an old volume back.

   ES5 and no DOM, like checklist.js: server modules import this file as it is.
   ========================================================================= */

export var DEFAULT_VOLUME = 100;
/** The slider's and − / +'s step. */
export var STEP = 5;
/** "Mluv tišeji" without a number: a step you can hear. */
export var VOICE_STEP = 15;

/** A stored or sent volume as a whole number 0–100, on the 5 % grid;
    anything unreadable is `fallback` (the default 100). */
export function clampVolume(v, fallback) {
  var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !isFinite(n)) return fallback === undefined ? DEFAULT_VOLUME : fallback;
  return Math.max(0, Math.min(100, Math.round(n / STEP) * STEP));
}

/** Whether `v` is something a client may send: a number 0–100. */
export function validVolume(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100;
}

/** The volume a settings object holds. */
export function volumeOf(settings) {
  return clampVolume(settings && settings.ttsVolume);
}

/** "70 %", or "ticho" at 0. */
export function volumeWords(v) {
  return v === 0 ? 'ticho' : v + ' %';
}

/** Where louder / quieter lands from `now`, by `by` (VOICE_STEP when not given). */
export function stepVolume(now, action, by) {
  var step = typeof by === 'number' && by > 0 ? by : VOICE_STEP;
  return clampVolume(now + (action === 'quieter' ? -step : step));
}
