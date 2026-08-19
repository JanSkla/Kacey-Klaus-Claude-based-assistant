/* =========================================================================
   Every user-visible string, in both languages.

   Kept apart from the code that shows them so a wording change never means
   reading logic, and so a missing translation is obvious rather than buried
   three screens into a function. `t()` resolves against the live language, so
   callers read `t().thinking` at the moment they need it and never cache it.
   ========================================================================= */

import { state } from './state.js';

var STR = {
  'cs-CZ': {
    you: 'Já', kacey: 'Kacey',
    langLabel: 'Jazyk',
    connecting: 'Připojuji…', online: 'Připojeno', offline: 'Offline',
    reconnecting: function (s) { return 'Offline · nový pokus za ' + s + ' s'; },
    placeholder: 'Napiš zprávu…',
    send: 'Odeslat zprávu', stop: 'Zastavit odpověď',
    inputLabel: 'Zpráva',
    micStart: 'Začít mluvit', micStop: 'Přestat nahrávat',
    muteOn: 'Vypnout mluvení nahlas', muteOff: 'Zapnout mluvení nahlas',
    listening: 'Poslouchám…', listenHold: 'Mluv, po chvilce ticha to odešlu.',
    micHint: 'Klepni a mluv', thinking: 'Kacey přemýšlí…', speaking: 'Kacey mluví…',
    tool: function (n) { return n === 'klaus-memory' ? 'Prohledávám paměť…' : 'Používám ' + n + '…'; },
    readyInfo: function (model, mcp) {
      return 'Připojeno · ' + model + (mcp && mcp.length ? ' · ' + mcp.join(', ') : '');
    },
    errNoSpeech: 'Nic jsem neslyšela. Zkus to znovu.',
    errDenied: 'Přístup k mikrofonu byl zamítnut. Povol ho v nastavení prohlížeče.',
    errAudio: 'Mikrofon není dostupný.',
    errNet: 'Rozpoznávání řeči selhalo kvůli síti. Napiš to prosím.',
    errRec: 'Rozpoznávání řeči selhalo. Napiš to prosím.',
    errUnsupported: 'Tento prohlížeč neumí rozpoznávat řeč. Použij psaní (nebo Chrome / Edge).',
    errInsecure: 'Mikrofon funguje jen přes HTTPS nebo na localhostu. Otevři Kacey přes https:// (např. Tailscale Serve), jinak zbývá psaní.',
    errNoTTS: 'Tento prohlížeč neumí mluvit nahlas.',
    errNoVoice: function (l) { return 'Není nainstalovaný hlas pro ' + l + ' — čtu nahlas výchozím hlasem.'; },
    errOfflineSend: 'Nejsi připojená k serveru — zpráva nebyla odeslána.',
    interrupted: 'Přerušeno.',
    mockHint: 'MOCK režim: /error, /offline, /long',
    wakeOn: 'Slovo „KC“ zapne diktování — poslouchám (přepis)',
    wakeOnVoice: 'Slovo „KC“ zapne diktování — poslouchám (můj hlas)',
    wakeOff: 'Slovo „KC“ nepoužívat',
    wakeBlocked: 'Mikrofon není povolen, „KC“ nefunguje',
    wakeCfgHint: 'podržením nastavíš hlasový podpis',
    closed: 'Hovor ukončen. Řekni „KC“, až budeš chtít pokračovat.',
    silenced: 'Ticho.'
  },
  'en-US': {
    you: 'You', kacey: 'Kacey',
    langLabel: 'Language',
    connecting: 'Connecting…', online: 'Connected', offline: 'Offline',
    reconnecting: function (s) { return 'Offline · retrying in ' + s + 's'; },
    placeholder: 'Type a message…',
    send: 'Send message', stop: 'Stop the response',
    inputLabel: 'Message',
    micStart: 'Start talking', micStop: 'Stop recording',
    muteOn: 'Mute spoken replies', muteOff: 'Unmute spoken replies',
    listening: 'Listening…', listenHold: 'Speak — I will send it after a pause.',
    micHint: 'Tap and speak', thinking: 'Kacey is thinking…', speaking: 'Kacey is speaking…',
    tool: function (n) { return n === 'klaus-memory' ? 'Recalling memory…' : 'Using ' + n + '…'; },
    readyInfo: function (model, mcp) {
      return 'Connected · ' + model + (mcp && mcp.length ? ' · ' + mcp.join(', ') : '');
    },
    errNoSpeech: 'I did not hear anything. Try again.',
    errDenied: 'Microphone access was denied. Allow it in your browser settings.',
    errAudio: 'No microphone available.',
    errNet: 'Speech recognition failed (network). Please type instead.',
    errRec: 'Speech recognition failed. Please type instead.',
    errUnsupported: 'This browser cannot do speech recognition. Type instead (or use Chrome / Edge).',
    errInsecure: 'The microphone only works over HTTPS or on localhost. Open Kacey via https:// (e.g. Tailscale Serve), otherwise typing is the only input.',
    errNoTTS: 'This browser cannot speak out loud.',
    errNoVoice: function (l) { return 'No installed voice for ' + l + ' — using the default voice.'; },
    errOfflineSend: 'Not connected to the server — message was not sent.',
    interrupted: 'Interrupted.',
    mockHint: 'MOCK mode: /error, /offline, /long',
    wakeOn: 'Say "KC" to start dictation — listening (transcript)',
    wakeOnVoice: 'Say "KC" to start dictation — listening (my voice)',
    wakeOff: 'Wake word "KC" off',
    wakeBlocked: 'Microphone not allowed, "KC" cannot work',
    wakeCfgHint: 'hold to set up your voiceprint',
    closed: 'Conversation ended. Say "KC" when you want to continue.',
    silenced: 'Quiet.'
  }
};

export function t() { return STR[state.lang] || STR['en-US']; }
