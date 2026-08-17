/**
 * Voice Lab — TTS provider adapters.
 *
 * Every adapter exposes the same two calls:
 *   listVoices()            -> [{ id, label, gender, note }]   (Czech-capable only)
 *   speak({ voice, text, tuning }) -> { audio: Buffer, mime: string }
 *
 * API keys are read from the environment and NEVER leave this process — the
 * browser talks to our own /api/tts and gets audio bytes back, so no key is
 * ever embedded in a page, stored in localStorage, or logged.
 */

const CZ = 'cs-CZ';

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function need(...names) {
  const missing = names.filter((n) => !process.env[n]);
  return { ok: missing.length === 0, missing };
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function failBody(res) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {
    /* body already consumed or empty */
  }
  return `${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`;
}

// --------------------------------------------------------------------------
// Azure AI Speech
// --------------------------------------------------------------------------

const azure = {
  id: 'azure',
  label: 'Azure Neural',
  env: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
  hint: 'Czech is a first-class locale here. cs-CZ-VlastaNeural is the female voice.',
  // Tuning surface shown in the UI.
  controls: [
    { key: 'rate', label: 'Tempo', type: 'range', min: -40, max: 40, step: 5, def: 0, unit: '%' },
    { key: 'pitch', label: 'Výška', type: 'range', min: -30, max: 30, step: 5, def: 0, unit: '%' },
  ],

  status() {
    return need(...this.env);
  },

  async listVoices() {
    const region = process.env.AZURE_SPEECH_REGION;
    const res = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY } },
    );
    if (!res.ok) throw new Error(`Azure voice list failed: ${await failBody(res)}`);
    const all = await res.json();
    return all
      .filter((v) => v.Locale === CZ)
      .map((v) => ({
        id: v.ShortName,
        label: v.LocalName || v.DisplayName || v.ShortName,
        gender: (v.Gender || '').toLowerCase(),
        note: v.VoiceType === 'Neural' ? 'neural' : v.VoiceType,
      }));
  },

  async speak({ voice, text, tuning = {} }) {
    const region = process.env.AZURE_SPEECH_REGION;
    const rate = Number(tuning.rate || 0);
    const pitch = Number(tuning.pitch || 0);
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${CZ}">` +
      `<voice name="${xmlEscape(voice)}">` +
      `<prosody rate="${rate >= 0 ? '+' : ''}${rate}%" pitch="${pitch >= 0 ? '+' : ''}${pitch}%">` +
      xmlEscape(text) +
      `</prosody></voice></speak>`;

    const res = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'kacey-voicelab',
        },
        body: ssml,
      },
    );
    if (!res.ok) throw new Error(`Azure synthesis failed: ${await failBody(res)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  },
};

// --------------------------------------------------------------------------
// ElevenLabs
// --------------------------------------------------------------------------

const elevenlabs = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  env: ['ELEVENLABS_API_KEY'],
  hint:
    'Voices are language-agnostic — any voice can speak Czech via a multilingual model. ' +
    'Quality varies a lot per voice, which is exactly what this lab is for.',
  controls: [
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      options: [
        { value: 'eleven_multilingual_v2', label: 'multilingual v2 (safe)' },
        { value: 'eleven_turbo_v2_5', label: 'turbo v2.5 (fast)' },
        { value: 'eleven_v3', label: 'v3 (most expressive)' },
      ],
      def: 'eleven_multilingual_v2',
    },
    { key: 'stability', label: 'Stabilita', type: 'range', min: 0, max: 100, step: 5, def: 50, unit: '%' },
    { key: 'style', label: 'Styl', type: 'range', min: 0, max: 100, step: 5, def: 0, unit: '%' },
  ],

  status() {
    return need(...this.env);
  },

  async listVoices() {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    if (!res.ok) throw new Error(`ElevenLabs voice list failed: ${await failBody(res)}`);
    const data = await res.json();
    return (data.voices || []).map((v) => ({
      id: v.voice_id,
      label: v.name,
      gender: (v.labels && v.labels.gender ? v.labels.gender : '').toLowerCase(),
      note: [v.labels && v.labels.accent, v.labels && v.labels.description]
        .filter(Boolean)
        .join(', '),
    }));
  },

  async speak({ voice, text, tuning = {} }) {
    const model = tuning.model || 'eleven_multilingual_v2';
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability: Number(tuning.stability ?? 50) / 100,
            similarity_boost: 0.75,
            style: Number(tuning.style ?? 0) / 100,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs synthesis failed: ${await failBody(res)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  },
};

// --------------------------------------------------------------------------
// OpenAI (gpt-4o-mini-tts) — steerable by a plain-language instruction
// --------------------------------------------------------------------------

const openai = {
  id: 'openai',
  label: 'OpenAI',
  env: ['OPENAI_API_KEY'],
  hint:
    'The only provider here where you tune the vibe by describing it in words. ' +
    'Voices are not officially gendered; the ones below are the female-presenting set.',
  controls: [
    {
      key: 'instructions',
      label: 'Pokyn k podání (vibe)',
      type: 'textarea',
      def:
        'Mluv klidně a nenápadně, jako zkušená komorná ve službě. ' +
        'Nespěchej, nezvyšuj hlas, drž rovný a vlídný tón. Žádná přehnaná vřelost.',
    },
  ],

  status() {
    return need(...this.env);
  },

  async listVoices() {
    // OpenAI has no voice-list endpoint; this is the documented set, filtered to
    // the female-presenting voices since that is what this lab is choosing between.
    return [
      { id: 'coral', label: 'Coral', gender: 'female', note: 'warm, bright' },
      { id: 'nova', label: 'Nova', gender: 'female', note: 'crisp, energetic' },
      { id: 'shimmer', label: 'Shimmer', gender: 'female', note: 'soft, airy' },
      { id: 'sage', label: 'Sage', gender: 'female', note: 'calm, measured' },
      { id: 'ballad', label: 'Ballad', gender: 'female', note: 'expressive' },
      { id: 'alloy', label: 'Alloy', gender: 'neutral', note: 'neutral baseline' },
    ];
  },

  async speak({ voice, text, tuning = {} }) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice,
        input: text,
        instructions: tuning.instructions || undefined,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`OpenAI synthesis failed: ${await failBody(res)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  },
};

// --------------------------------------------------------------------------
// Google Cloud Text-to-Speech
// --------------------------------------------------------------------------

const google = {
  id: 'google',
  label: 'Google Cloud',
  env: ['GOOGLE_API_KEY'],
  hint: 'Uses an API key (not a service-account file). Chirp/WaveNet cs-CZ voices.',
  controls: [
    { key: 'rate', label: 'Tempo', type: 'range', min: 60, max: 140, step: 5, def: 100, unit: '%' },
    { key: 'pitch', label: 'Výška', type: 'range', min: -8, max: 8, step: 1, def: 0, unit: 'st' },
  ],

  status() {
    return need(...this.env);
  },

  async listVoices() {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/voices?languageCode=${CZ}&key=${process.env.GOOGLE_API_KEY}`,
    );
    if (!res.ok) throw new Error(`Google voice list failed: ${await failBody(res)}`);
    const data = await res.json();
    return (data.voices || []).map((v) => ({
      id: v.name,
      label: v.name,
      gender: (v.ssmlGender || '').toLowerCase(),
      note: `${v.naturalSampleRateHertz || ''} Hz`.trim(),
    }));
  },

  async speak({ voice, text, tuning = {} }) {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: CZ, name: voice },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: Number(tuning.rate ?? 100) / 100,
            pitch: Number(tuning.pitch ?? 0),
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`Google synthesis failed: ${await failBody(res)}`);
    const data = await res.json();
    if (!data.audioContent) throw new Error('Google returned no audioContent');
    return { audio: Buffer.from(data.audioContent, 'base64'), mime: 'audio/mpeg' };
  },
};

// --------------------------------------------------------------------------
// XTTS-v2 (Coqui) — fully local, no API key, no network
// --------------------------------------------------------------------------

const XTTS_URL = process.env.XTTS_URL || 'http://127.0.0.1:8790';

const xtts = {
  id: 'xtts',
  label: 'XTTS-v2 (lokálně)',
  env: [], // no key — needs the Python side running instead
  hint:
    'Běží u tebe na CPU, nic neodchází ze stroje. Zabudované studiové hlasy ' +
    '(se souhlasem mluvčích), čeština mezi 17 jazyky. Pomalejší než cloud — ' +
    'tohle je poslechová laboratoř, ne provoz.',
  controls: [
    { key: 'speed', label: 'Tempo', type: 'range', min: 70, max: 130, step: 5, def: 100, unit: '%' },
  ],

  status() {
    return { ok: true, missing: [] };
  },

  async listVoices() {
    let res;
    try {
      res = await fetch(`${XTTS_URL}/health`, { signal: AbortSignal.timeout(4000) });
    } catch {
      throw new Error(
        'XTTS server neběží. Spusť ho: .venv-xtts\\Scripts\\python.exe voicelab/xtts_server.py',
      );
    }
    if (!res.ok) throw new Error(`XTTS health failed: ${await failBody(res)}`);
    const info = await res.json();
    if (!info.ok) throw new Error('XTTS model se ještě načítá — zkus to za chvíli.');
    if (!(info.languages || []).includes('cs')) {
      throw new Error('Tento XTTS model nehlásí podporu češtiny.');
    }
    return (info.speakers || []).map((name) => ({
      id: name,
      label: name,
      gender: '',
      note: 'studiový hlas',
    }));
  },

  async speak({ voice, text, tuning = {} }) {
    const res = await fetch(`${XTTS_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        speaker: voice,
        language: 'cs',
        speed: Number(tuning.speed ?? 100) / 100,
      }),
      // CPU synthesis is slow; a short timeout would kill valid requests.
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`XTTS synthesis failed: ${await failBody(res)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/wav' };
  },
};

export const PROVIDERS = [xtts, azure, elevenlabs, openai, google];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

/** Public description of every provider — no secrets, safe to send to the page. */
export function describeProviders() {
  return PROVIDERS.map((p) => {
    const s = p.status();
    return {
      id: p.id,
      label: p.label,
      hint: p.hint,
      configured: s.ok,
      missingEnv: s.missing,
      controls: p.controls || [],
    };
  });
}
