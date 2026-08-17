/**
 * Voice Lab — a standalone bench for picking Kacey's Czech voice.
 *
 * Run it next to the main app:   npm run voicelab      (default port 8788)
 *
 * It never touches the Kacey server, the persona, or klaus_memory. Provider API
 * keys are read from the environment in this process only; the browser calls
 * /api/tts and receives audio bytes, so no key is ever exposed to a page.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDERS, describeProviders, getProvider } from './providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VOICELAB_PORT || 8788);

const log = (m) => console.log(`[voicelab] ${m}`);

// Synthesised audio is cached by (provider, voice, text, tuning) so replaying a
// clip while comparing does not bill the provider again. Bounded, in-memory only.
const cache = new Map();
const CACHE_MAX = 400;

function cacheKey(o) {
  return createHash('sha1').update(JSON.stringify(o)).digest('hex');
}

function cachePut(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(HERE, 'public')));

app.get('/api/providers', (_req, res) => {
  res.json({ providers: describeProviders() });
});

/* ---------------------------------------------------------------------------
 * Persisted judgement: ratings, notes, gender tags, tuning, last sentence.
 * localStorage alone would lose everything to a cleared cache or a different
 * browser, and this is hours of listening — it belongs on disk.
 * ------------------------------------------------------------------------- */

const STATE_FILE = path.join(HERE, 'state.json');

app.get('/api/state', (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`state read failed: ${err.message}`);
    res.json({});                                  // first run — nothing saved yet
  }
});

app.put('/api/state', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'expected a JSON object' });
  }
  try {
    // Write-then-rename so an interrupted save cannot truncate existing scores.
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    log(`state write failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Czech-capable voices for one provider, or for every configured provider. */
app.get('/api/voices', async (req, res) => {
  const wanted = req.query.provider
    ? PROVIDERS.filter((p) => p.id === req.query.provider)
    : PROVIDERS;

  const out = await Promise.all(
    wanted.map(async (p) => {
      const status = p.status();
      if (!status.ok) {
        return { provider: p.id, configured: false, missingEnv: status.missing, voices: [] };
      }
      try {
        const voices = await p.listVoices();
        return { provider: p.id, configured: true, voices };
      } catch (err) {
        // A bad key or a wrong region shows up here — surface it, do not hide it.
        return { provider: p.id, configured: true, error: err.message, voices: [] };
      }
    }),
  );

  res.json({ results: out });
});

/**
 * Progressive synthesis (XTTS only). Pipes raw PCM straight through as it is
 * produced — buffering here would throw away the entire benefit, since the win
 * is time-to-first-audio (~2s) rather than total time.
 */
app.post('/api/tts/stream', async (req, res) => {
  const { voice, text, tuning } = req.body || {};
  if (!voice || !text) return res.status(400).json({ error: 'voice and text are required' });

  const XTTS_URL = process.env.XTTS_URL || 'http://127.0.0.1:8790';
  let upstream;
  try {
    upstream = await fetch(`${XTTS_URL}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        speaker: voice,
        language: 'cs',
        speed: Number((tuning && tuning.speed) ?? 100) / 100,
      }),
    });
  } catch {
    return res.status(502).json({ error: 'XTTS server neběží (npm run xtts)' });
  }
  if (!upstream.ok || !upstream.body) {
    return res.status(502).json({ error: `XTTS stream failed: ${upstream.status}` });
  }

  const started = Date.now();
  let bytes = 0;
  let first = null;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Sample-Rate', upstream.headers.get('X-Sample-Rate') || '24000');

  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first === null) first = Date.now() - started;
      bytes += value.length;
      res.write(Buffer.from(value));
    }
    res.end();
    log(`stream ${voice}: first ${first} ms, ${bytes} B in ${Date.now() - started} ms`);
  } catch (err) {
    log(`stream ERROR ${voice}: ${err.message}`);
    res.destroy();
  }
});

app.post('/api/tts', async (req, res) => {
  const { provider: id, voice, text, tuning } = req.body || {};
  if (!id || !voice || !text) {
    return res.status(400).json({ error: 'provider, voice and text are required' });
  }

  const p = getProvider(id);
  if (!p) return res.status(404).json({ error: `unknown provider "${id}"` });

  const status = p.status();
  if (!status.ok) {
    return res
      .status(412)
      .json({ error: `${p.label} is not configured. Set: ${status.missing.join(', ')}` });
  }

  const key = cacheKey({ id, voice, text, tuning });
  const hit = cache.get(key);
  if (hit) {
    res.setHeader('Content-Type', hit.mime);
    res.setHeader('X-Voicelab-Cache', 'hit');
    return res.end(hit.audio);
  }

  try {
    const started = Date.now();
    const { audio, mime } = await p.speak({ voice, text, tuning: tuning || {} });
    const ms = Date.now() - started;
    cachePut(key, { audio, mime });
    log(`${id}/${voice} ${text.length} chars -> ${audio.length} B in ${ms} ms`);
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Voicelab-Cache', 'miss');
    res.setHeader('X-Voicelab-Ms', String(ms));
    res.end(audio);
  } catch (err) {
    log(`ERROR ${id}/${voice}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}`);
  for (const p of describeProviders()) {
    log(
      p.configured
        ? `${p.label}: ready`
        : `${p.label}: not configured (set ${p.missingEnv.join(', ')})`,
    );
  }
});
