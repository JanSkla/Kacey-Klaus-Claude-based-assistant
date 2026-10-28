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
    tool: function (n) {
      if (n === 'app_gallery_save') return 'Ukládám fotku do galerie…';
      if (n === 'app_gallery_search') return 'Hledám v galerii…';
      if (n === 'app_whiteboard_read') return 'Prohlížím whiteboard…';
      if (n === 'app_whiteboard_edit') return 'Kreslím na whiteboard…';
      if (n === 'app_whiteboard_manage') return 'Chystám whiteboard…';
      if (n === 'app_sticky') return 'Sahám na lístečky…';
      if (n === 'app_task_list') return 'Píšu do seznamu u úkolu…';
      if (n === 'app_storage') return 'Sahám do úložiště…';
      if (n === 'WebSearch') return 'Hledám na internetu…';
      if (n === 'WebFetch') return 'Čtu webovou stránku…';
      return n === 'klaus-memory' ? 'Prohledávám paměť…' : 'Používám ' + n + '…';
    },
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
    errNoAudio: 'Mikrofon se zapnul, ale nejde z něj žádný zvuk. Zkontroluj, jestli není ztlumený a který je vybraný, a zkus to znovu.',
    errSttLoading: 'Whisper si ještě načítá model — za chvilku to půjde. Zatím to můžeš napsat.',
    errSttDown: 'Whisper tvoji větu nepřepsal — neodpovídá. Zkus to znovu, nebo to napiš.',
    errNativeFallback: 'Rozpoznávání v prohlížeči nefunguje — přepínám na Whisper. Řekni to prosím znovu.',
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
    paused: 'Počkám.'
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
    tool: function (n) {
      if (n === 'WebSearch') return 'Searching the web…';
      if (n === 'WebFetch') return 'Reading a web page…';
      return n === 'klaus-memory' ? 'Recalling memory…' : 'Using ' + n + '…';
    },
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
    errNoAudio: 'The microphone opened but gives no sound. Check that it is not muted and which one is selected, then try again.',
    errSttLoading: 'Whisper is still loading its model — give it a moment, or type instead.',
    errSttDown: 'Whisper did not write that down — it is not answering. Try again, or type instead.',
    errNativeFallback: 'The browser\'s recognition is not working — switching to Whisper. Please say it again.',
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
    paused: 'Waiting.'
  }
};

export function t() { return STR[state.lang] || STR['en-US']; }
