/* Voice Lab — pick Kacey's Czech voice by ear.
   Vanilla, no build step. Ratings and notes live in localStorage. */
(function () {
  'use strict';

  // Deliberately awkward Czech: ř/ě/ů/š, a name that must decline, times spoken
  // as words, and the butler cadence Kacey actually uses.
  var PRESETS = [
    {
      id: 'meeting',
      label: 'Schůzka',
      text: 'Zítra v deset máte schůzku s panem Petrem, a nedoporučovala bych pozdní návrat.',
    },
    {
      id: 'memory',
      label: 'Paměť',
      text: 'Vím, že si nikdy neplánujete schůzky před devátou hodinou ranní, a že máte kočku Poppy a psa Rexe.',
    },
    {
      id: 'note',
      label: 'Poznamenáno',
      text: 'Poznamenáno — schůzky nejdříve od deváté.',
    },
    {
      id: 'hard',
      label: 'Zákeřná',
      text: 'Odpusťte, nezachytila jsem jméno správně. Řekl jste Řehoř, nebo Jiří? Přeslechla jsem se.',
    },
    {
      id: 'care',
      label: 'Diskrétní',
      text: 'Dovolím si podotknout, že vaše alergie na penicilin je v této souvislosti podstatná.',
    },
  ];

  var STORE_KEY = 'voicelab.v1';

  var els = {
    presets: document.getElementById('presets'),
    text: document.getElementById('text'),
    charCount: document.getElementById('charCount'),
    autoplay: document.getElementById('autoplay'),
    providers: document.getElementById('providers'),
    fStars: document.getElementById('fStars'),
    fGender: document.getElementById('fGender'),
    filterCount: document.getElementById('filterCount'),
    shortlist: document.getElementById('shortlist'),
    config: document.getElementById('config'),
    reloadBtn: document.getElementById('reloadBtn'),
    blindBtn: document.getElementById('blindBtn'),
    toast: document.getElementById('toast'),
  };

  var store = load();
  var catalogue = [];        // [{provider, label, voices:[...], controls, error}]
  var current = null;        // currently playing HTMLAudioElement
  var toastTimer = 0;

  // ---------------------------------------------------------------- storage

  function blank() {
    return { ratings: {}, notes: {}, tuning: {}, tags: {}, text: '' };
  }

  /* localStorage is the fast local copy; the server file is the durable one, so
     scores survive a cleared cache or a different browser. Local loads first so
     the page is never blank, then the server copy is merged in. */
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!s) return blank();
      var base = blank();
      Object.keys(base).forEach(function (k) { if (s[k] === undefined) s[k] = base[k]; });
      return s;
    } catch (e) {
      return blank();
    }
  }

  function loadRemote() {
    return fetch('/api/state')
      .then(function (r) { return r.json(); })
      .then(function (remote) {
        if (!remote || typeof remote !== 'object') return;
        var local = store;
        var hasLocal = Object.keys(local.ratings).length || Object.keys(local.notes).length;
        // Server wins on first load; if this browser already had work, keep it
        // and let the next save push it up rather than silently discarding it.
        if (!hasLocal) {
          store = Object.assign(blank(), remote);
          if (store.text && els.text) { els.text.value = store.text; updateCount(); }
        }
      })
      .catch(function () { /* offline / no server file — local copy stands */ });
  }

  var saveTimer = 0;
  var saveEl = document.getElementById('saveState');

  function setSaveState(text, cls) {
    if (!saveEl) return;
    saveEl.textContent = text;
    saveEl.className = 'save-state' + (cls ? ' save-state--' + cls : '');
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* quota */ }
    // Debounced: dragging a slider or typing a note must not spam the disk.
    setSaveState('ukládám…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushState, 600);
  }

  function pushState() {
    if (els.text) store.text = els.text.value;
    return fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(store),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        setSaveState('uloženo', 'ok');
      })
      .catch(function () {
        setSaveState('neuloženo na disk (jen v prohlížeči)', 'bad');
      });
  }

  function vkey(p, v) { return p + '::' + v; }

  // ------------------------------------------------------------------- misc

  function toast(msg, bad) {
    els.toast.textContent = msg;
    els.toast.className = 'toast toast--on' + (bad ? ' toast--bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, 4200);
  }

  function stopAudio() {
    if (current) { try { current.pause(); } catch (e) {} current = null; }
    if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) {} }
    if (streamStop) { try { streamStop(); } catch (e) {} streamStop = null; }
  }

  function tuningFor(providerId) {
    if (!store.tuning[providerId]) store.tuning[providerId] = {};
    return store.tuning[providerId];
  }

  // ------------------------------------------------------------------ audio

  /* ---- progressive playback (XTTS) --------------------------------------
     The server streams raw int16 PCM as the model produces it. We decode each
     chunk and schedule it on a Web Audio timeline, so audio starts at the first
     chunk (~2s) instead of after the whole sentence (~6s+). Chunks are appended
     at a running cursor so playback is gapless even though they arrive late. */
  var audioCtx = null;

  function streamXtts(voiceId, text, onFirstAudio) {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return Promise.reject(new Error('Web Audio není k dispozici'));
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();

    stopAudio();
    var ctx = audioCtx;
    var cursor = 0;          // when the next chunk should start
    var tail = null;         // odd trailing byte carried across chunk boundaries
    var sources = [];
    var started = Date.now();
    var firstReported = false;
    var pending = [];        // decoded chunks not yet scheduled
    var playing = false;     // has the prebuffer gate opened?
    var bufferedAudio = 0;   // seconds of audio received so far
    // ~0.075 s of speech per character, measured across the benchmark sentences.
    var estAudio = text.length * 0.075;

    /* Schedule everything buffered so far, back to back. */
    function flush() {
      while (pending.length) {
        var b = pending.shift();
        var src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(ctx.destination);
        var now = ctx.currentTime;
        if (cursor < now) cursor = now + 0.02;    // fell behind — resync
        src.start(cursor);
        cursor += b.duration;
        sources.push(src);

        if (!firstReported) {
          firstReported = true;
          if (onFirstAudio) onFirstAudio(Date.now() - started);
        }
      }
    }

    streamStop = function () {
      sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
      sources = [];
    };

    return fetch('/api/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceId, text: text, tuning: tuningFor('xtts') }),
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ('HTTP ' + res.status));
        });
      }
      var rate = Number(res.headers.get('X-Sample-Rate')) || 24000;
      var reader = res.body.getReader();

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          var bytes = r.value;

          // carry any odd byte so int16 frames never straddle a chunk edge
          if (tail) {
            var merged = new Uint8Array(tail.length + bytes.length);
            merged.set(tail, 0); merged.set(bytes, tail.length);
            bytes = merged; tail = null;
          }
          var usable = bytes.length - (bytes.length % 2);
          if (usable < bytes.length) tail = bytes.slice(usable);
          if (usable > 0) {
            var view = new DataView(bytes.buffer, bytes.byteOffset, usable);
            var frames = usable / 2;
            var buf = ctx.createBuffer(1, frames, rate);
            var ch = buf.getChannelData(0);
            for (var i = 0; i < frames; i++) ch[i] = view.getInt16(i * 2, true) / 32768;

            pending.push(buf);
            bufferedAudio += buf.duration;

            /* Measured on this CPU: XTTS generates at ~4.6x real-time, so playing
               the first chunk the moment it lands produces 0.9s of speech then a
               widening silence. Instead, hold until enough is buffered that the
               rest will arrive before playback catches up — one upfront wait
               rather than a stutter. When generation is faster than real-time
               (GPU, or a lighter model) the gate opens on the first chunk. */
            if (!playing) {
              var elapsed = (Date.now() - started) / 1000;
              var factor = elapsed / Math.max(bufferedAudio, 0.01);   // observed slowdown
              var estTotal = Math.max(estAudio, bufferedAudio);
              var needed = factor <= 1
                ? 0
                : (estTotal - bufferedAudio / factor) * (1 - 1 / factor) + 0.25;
              if (bufferedAudio >= Math.min(needed, estTotal)) playing = true;
            }

            if (playing) flush();
          }
          return pump();
        });
      }

      return pump().then(function () {
        playing = true;
        flush();                                   // gate never opened — play it all now
        // resolve when the last scheduled chunk has actually finished sounding
        var remaining = Math.max(0, (cursor - ctx.currentTime) * 1000);
        return new Promise(function (r) { setTimeout(r, remaining); });
      });
    });
  }

  var streamStop = null;

  /* Returns a Promise resolving once playback finishes (or rejects on error). */
  function synth(providerId, voiceId, text) {
    if (providerId === 'browser') return speakBrowser(voiceId, text);

    return fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerId, voice: voiceId, text: text, tuning: tuningFor(providerId),
      }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ('HTTP ' + res.status));
        });
      }
      var ms = res.headers.get('X-Voicelab-Ms');
      var cached = res.headers.get('X-Voicelab-Cache') === 'hit';
      return res.blob().then(function (blob) {
        return { url: URL.createObjectURL(blob), ms: ms, cached: cached };
      });
    });
  }

  function play(clip) {
    return new Promise(function (resolve, reject) {
      stopAudio();
      var a = new Audio(clip.url);
      current = a;
      a.onended = function () { resolve(); };
      a.onerror = function () { reject(new Error('přehrávání selhalo')); };
      a.play().catch(reject);
    });
  }

  /* The browser baseline — whatever Windows/Edge already has installed. */
  function speakBrowser(voiceName, text) {
    return new Promise(function (resolve, reject) {
      if (!window.speechSynthesis) return reject(new Error('speechSynthesis není k dispozici'));
      stopAudio();
      var u = new SpeechSynthesisUtterance(text);
      var match = speechSynthesis.getVoices().filter(function (v) { return v.name === voiceName; })[0];
      if (match) { u.voice = match; u.lang = match.lang; } else { u.lang = 'cs-CZ'; }
      u.onend = function () { resolve({ browser: true }); };
      u.onerror = function () { reject(new Error('speechSynthesis selhal')); };
      speechSynthesis.speak(u);
    });
  }

  function playVoice(providerId, voiceId, btn) {
    var text = els.text.value.trim();
    if (!text) { toast('Nejdřív napiš větu.', true); return Promise.reject(); }

    if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
    var done = function () { if (btn) { btn.disabled = false; delete btn.dataset.busy; } };
    var meta = document.getElementById('meta-' + vkey(providerId, voiceId).replace(/\W/g, '_'));

    // XTTS streams: audio starts at the first chunk instead of after the whole
    // sentence. Every other provider returns one finished clip.
    if (providerId === 'xtts') {
      return streamXtts(voiceId, text, function (ms) {
        if (meta) meta.textContent = 'první zvuk ' + ms + ' ms';
      })
        .then(done)
        .catch(function (err) {
          done();
          if (err && err.message) toast(err.message, true);
          throw err;
        });
    }

    return synth(providerId, voiceId, text)
      .then(function (clip) {
        if (clip && clip.browser) { done(); return; }
        if (clip.ms) {
          var meta = document.getElementById('meta-' + vkey(providerId, voiceId).replace(/\W/g, '_'));
          if (meta) meta.textContent = clip.cached ? 'z cache' : clip.ms + ' ms';
        }
        if (!els.autoplay.checked) { done(); return; }
        return play(clip).then(done);
      })
      .catch(function (err) {
        done();
        if (err && err.message) toast(err.message, true);
        throw err;
      });
  }

  // ----------------------------------------------------------------- render

  function presetChips() {
    PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.label;
      b.onclick = function () {
        els.text.value = p.text;
        updateCount();
        [].forEach.call(els.presets.children, function (c) { c.classList.remove('chip--on'); });
        b.classList.add('chip--on');
      };
      els.presets.appendChild(b);
    });
    els.text.value = PRESETS[0].text;
    els.presets.firstChild.classList.add('chip--on');
    updateCount();
  }

  function updateCount() {
    els.charCount.textContent = els.text.value.trim().length + ' znaků';
  }

  function controlRow(providerId, ctrl) {
    var wrap = document.createElement('label');
    wrap.className = 'ctrl';
    var t = tuningFor(providerId);
    if (t[ctrl.key] === undefined) t[ctrl.key] = ctrl.def;

    var name = document.createElement('span');
    name.className = 'ctrl__label';
    name.textContent = ctrl.label;
    wrap.appendChild(name);

    var input;
    if (ctrl.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = ctrl.min; input.max = ctrl.max; input.step = ctrl.step;
      input.value = t[ctrl.key];
      var out = document.createElement('output');
      out.textContent = t[ctrl.key] + (ctrl.unit || '');
      input.oninput = function () {
        t[ctrl.key] = Number(input.value);
        out.textContent = input.value + (ctrl.unit || '');
        save();
      };
      wrap.appendChild(input);
      wrap.appendChild(out);
    } else if (ctrl.type === 'select') {
      input = document.createElement('select');
      ctrl.options.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o.value; op.textContent = o.label;
        input.appendChild(op);
      });
      input.value = t[ctrl.key];
      input.onchange = function () { t[ctrl.key] = input.value; save(); };
      wrap.appendChild(input);
    } else {
      input = document.createElement('textarea');
      input.rows = 3;
      input.value = t[ctrl.key] || '';
      input.oninput = function () { t[ctrl.key] = input.value; save(); };
      wrap.classList.add('ctrl--wide');
      wrap.appendChild(input);
    }
    return wrap;
  }

  /* ♀ / ♂ / untagged, cycled by clicking. Providers that report a gender seed the
     initial value (Azure, Google, ElevenLabs do; XTTS's 58 speakers do not), but a
     manual tag always wins — the point is to mark what you actually hear. */
  function genderTag(providerId, v) {
    var k = vkey(providerId, v.id);
    if (store.tags[k] === undefined && v.gender) {
      if (/female|woman/.test(v.gender)) store.tags[k] = 'f';
      else if (/male|man/.test(v.gender)) store.tags[k] = 'm';
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag';

    function paint() {
      var t = store.tags[k];
      btn.textContent = t === 'f' ? '♀' : t === 'm' ? '♂' : '–';
      btn.className = 'tag' + (t ? ' tag--' + t : '');
      btn.setAttribute(
        'aria-label',
        t === 'f' ? 'ženský hlas' : t === 'm' ? 'mužský hlas' : 'pohlaví neoznačeno',
      );
    }

    btn.onclick = function () {
      var t = store.tags[k];
      store.tags[k] = t === undefined ? 'f' : t === 'f' ? 'm' : undefined;
      if (store.tags[k] === undefined) delete store.tags[k];
      paint();
      save();
      applyFilter();
    };
    paint();
    return btn;
  }

  function stars(providerId, voiceId) {
    var box = document.createElement('div');
    box.className = 'stars';
    var k = vkey(providerId, voiceId);
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var s = document.createElement('button');
        s.type = 'button';
        s.className = 'star';
        s.textContent = '★';
        s.title = n + ' / 5';
        s.setAttribute('aria-label', n + ' z 5');
        if ((store.ratings[k] || 0) >= n) s.classList.add('star--on');
        s.onclick = function () {
          store.ratings[k] = store.ratings[k] === n ? 0 : n;
          save();
          [].forEach.call(box.children, function (c, idx) {
            c.classList.toggle('star--on', (store.ratings[k] || 0) >= idx + 1);
          });
          renderShortlist();
        };
        box.appendChild(s);
      })(i);
    }
    return box;
  }

  function voiceRow(providerId, v) {
    var k = vkey(providerId, v.id);
    var row = document.createElement('div');
    row.className = 'voice';
    row.id = 'row-' + k.replace(/\W/g, '_');   // the audition queue highlights this

    var main = document.createElement('div');
    main.className = 'voice__main';

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'play';
    play.textContent = '▶';
    play.setAttribute('aria-label', 'Přehrát ' + v.label);
    play.onclick = function () { playVoice(providerId, v.id, play).catch(function () {}); };
    main.appendChild(play);

    var name = document.createElement('div');
    name.className = 'voice__name';
    name.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = v.label;
    name.appendChild(strong);
    var meta = document.createElement('span');
    meta.className = 'voice__meta';
    meta.id = 'meta-' + k.replace(/\W/g, '_');
    meta.textContent = [v.gender, v.note].filter(Boolean).join(' · ');
    name.appendChild(meta);
    main.appendChild(name);

    main.appendChild(genderTag(providerId, v));
    main.appendChild(stars(providerId, v.id));

    var from = document.createElement('button');
    from.type = 'button';
    from.className = 'fromhere';
    from.textContent = '▶ odtud';
    from.title = 'Přehrát sekvenci od tohoto hlasu dál';
    from.onclick = function () { startQueue(collectVoices(null), vkey(providerId, v.id)); };
    main.appendChild(from);

    row.appendChild(main);

    var note = document.createElement('input');
    note.type = 'text';
    note.className = 'note';
    note.placeholder = 'poznámka — co ti na tom vadí / sedí';
    note.value = store.notes[k] || '';
    note.oninput = function () { store.notes[k] = note.value; save(); };
    row.appendChild(note);

    return row;
  }

  function providerCard(entry) {
    var card = document.createElement('section');
    card.className = 'prov';

    var head = document.createElement('div');
    head.className = 'prov__head';
    var h = document.createElement('h3');
    h.textContent = entry.label;
    head.appendChild(h);

    var badge = document.createElement('span');
    badge.className = 'badge';
    if (!entry.configured) {
      badge.classList.add('badge--off');
      badge.textContent = 'není nastaveno';
    } else if (entry.error) {
      badge.classList.add('badge--bad');
      badge.textContent = 'chyba';
    } else {
      badge.classList.add('badge--ok');
      badge.textContent = entry.voices.length + ' hlasů';
    }
    head.appendChild(badge);

    if (entry.configured && !entry.error && entry.voices.length > 1) {
      var all = document.createElement('button');
      all.type = 'button';
      all.className = 'prov__all';
      all.textContent = '▶ přehrát vše (' + entry.voices.length + ')';
      all.onclick = function () { startQueue(collectVoices(entry.provider)); };
      head.appendChild(all);
    }

    card.appendChild(head);

    if (entry.hint) {
      var hint = document.createElement('p');
      hint.className = 'muted small';
      hint.textContent = entry.hint;
      card.appendChild(hint);
    }

    if (!entry.configured) {
      var setup = document.createElement('pre');
      setup.className = 'setup';
      setup.textContent = entry.missingEnv
        .map(function (n) { return 'set ' + n + '=…'; })
        .join('\n');
      card.appendChild(setup);
      return card;
    }

    if (entry.error) {
      var err = document.createElement('p');
      err.className = 'err';
      err.textContent = entry.error;
      card.appendChild(err);
      return card;
    }

    if (entry.controls && entry.controls.length) {
      var ctrls = document.createElement('div');
      ctrls.className = 'ctrls';
      entry.controls.forEach(function (c) { ctrls.appendChild(controlRow(entry.provider, c)); });
      card.appendChild(ctrls);
    }

    var list = document.createElement('div');
    list.className = 'voices';
    if (!entry.voices.length) {
      var none = document.createElement('p');
      none.className = 'muted small';
      none.textContent = 'Žádné české hlasy.';
      list.appendChild(none);
    }
    entry.voices.forEach(function (v) { list.appendChild(voiceRow(entry.provider, v)); });
    card.appendChild(list);

    return card;
  }

  function renderShortlist() {
    var rated = Object.keys(store.ratings)
      .filter(function (k) { return store.ratings[k] > 0; })
      .sort(function (a, b) { return store.ratings[b] - store.ratings[a]; });

    els.shortlist.innerHTML = '';
    if (!rated.length) {
      var p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'Zatím žádné hodnocení. Dej hvězdy hlasům, které tě zaujmou.';
      els.shortlist.appendChild(p);
      els.config.hidden = true;
      return;
    }

    rated.forEach(function (k) {
      var parts = k.split('::');
      var row = document.createElement('div');
      row.className = 'pick';
      row.innerHTML = '';
      var n = document.createElement('span');
      n.textContent = '★'.repeat(store.ratings[k]) + ' · ' + parts[0] + ' / ' + parts[1];
      row.appendChild(n);
      if (store.notes[k]) {
        var note = document.createElement('em');
        note.className = 'muted small';
        note.textContent = store.notes[k];
        row.appendChild(note);
      }
      var use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn btn--ghost';
      use.textContent = 'použít';
      use.onclick = function () { showConfig(parts[0], parts[1]); };
      row.appendChild(use);
      els.shortlist.appendChild(row);
    });
  }

  function showConfig(providerId, voiceId) {
    var t = tuningFor(providerId);
    var lines = [
      '# Kacey TTS — vlož do .env nebo nastav v shellu',
      'KACEY_TTS=' + providerId,
      'KACEY_TTS_VOICE=' + voiceId,
    ];
    Object.keys(t).forEach(function (key) {
      if (t[key] !== '' && t[key] !== undefined) {
        lines.push('KACEY_TTS_' + key.toUpperCase() + '=' + String(t[key]).replace(/\n/g, ' '));
      }
    });
    els.config.textContent = lines.join('\n');
    els.config.hidden = false;
    els.config.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---- audition queue ----------------------------------------------------
     58 voices at ~15s each is not something anyone should click through. The
     queue plays them in order, marks the current one, and — because generation
     dominates playback on this hardware — starts synthesising the NEXT voice as
     soon as the current one begins sounding. That overlap is most of the win.
     ---------------------------------------------------------------------- */

  var queue = { items: [], i: -1, running: false, clips: {}, token: 0 };

  var np = {
    bar: document.getElementById('nowplaying'),
    name: document.getElementById('npName'),
    state: document.getElementById('npState'),
    count: document.getElementById('npCount'),
  };

  function markRow(item, cls) {
    if (!item || !item.row) return;
    item.row.classList.remove('voice--playing', 'voice--queued');
    if (cls) item.row.classList.add(cls);
  }

  function clearMarks() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.voice--playing, .voice--queued'),
      function (el) { el.classList.remove('voice--playing', 'voice--queued'); },
    );
  }

  function npShow(item, state, generating) {
    np.bar.hidden = false;
    np.bar.classList.toggle('np--gen', !!generating);
    np.name.textContent = item ? item.label : '—';
    np.state.textContent = state;
    np.count.textContent = (queue.i + 1) + ' / ' + queue.items.length;
  }

  function npHide() {
    np.bar.hidden = true;
    clearMarks();
  }

  /* Fetch (and cache) a finished clip. The queue uses whole clips rather than
     the streaming path so each voice plays gaplessly — for A/B judgement that
     matters more than shaving a second off the start. */
  function fetchClip(item) {
    var key = item.p + '::' + item.v + '::' + els.text.value.trim();
    if (queue.clips[key]) return queue.clips[key];

    var promise;
    if (item.p === 'browser') {
      promise = Promise.resolve({ browser: true });
    } else {
      promise = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: item.p, voice: item.v,
          text: els.text.value.trim(), tuning: tuningFor(item.p),
        }),
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            throw new Error(j.error || ('HTTP ' + res.status));
          });
        }
        return res.blob().then(function (b) { return { url: URL.createObjectURL(b) }; });
      });
    }
    queue.clips[key] = promise;
    // Any successful fetch marks the row ready — including the queue's own
    // prefetch, so a plain run leaves ✓ behind it as it goes.
    promise.then(function () { markReady(item, 'voice--ready'); }, function () {
      delete queue.clips[key];               // let a failure be retried
    });
    return promise;
  }

  /* startFrom: optional voice key to begin at — everything before it is skipped,
     so "▶ odtud" resumes a long sweep instead of restarting it. */
  /* ---- pre-generation ----------------------------------------------------
     Generation, not playback, is the bottleneck: ~15s a voice on this CPU. Doing
     it up front turns the listening pass into actual listening. Clips land in the
     same cache the queue reads, and the server caches by content hash too, so a
     page reload still replays instantly.
     ---------------------------------------------------------------------- */

  var pregen = { running: false, token: 0 };

  function markReady(item, cls) {
    if (!item || !item.row) return;
    item.row.classList.remove('voice--ready', 'voice--pregen');
    if (cls) item.row.classList.add(cls);
  }

  function startPregen(items) {
    if (!els.text.value.trim()) { toast('Nejdřív napiš větu.', true); return; }
    items = items.filter(function (it) { return it.p !== 'browser'; });  // nothing to cache
    if (!items.length) { toast('Žádné hlasy k předgenerování.', true); return; }

    stopPregen();
    pregen.running = true;
    var token = ++pregen.token;
    var done = 0, failed = 0;
    var t0 = Date.now();

    np.bar.hidden = false;
    np.bar.classList.add('np--gen');

    function step(idx) {
      if (!pregen.running || token !== pregen.token) return;
      if (idx >= items.length) {
        var secs = Math.round((Date.now() - t0) / 1000);
        toast('Předgenerováno ' + done + ' z ' + items.length +
              (failed ? ' (' + failed + ' selhalo)' : '') + ' za ' + secs + ' s');
        stopPregen();
        return;
      }
      var item = items[idx];
      markReady(item, 'voice--pregen');
      np.name.textContent = item.label;
      np.state.textContent = 'předgenerovávám…';
      np.count.textContent = (idx + 1) + ' / ' + items.length;

      fetchClip(item)
        .then(function () {
          if (token !== pregen.token) return;
          done++;
          markReady(item, 'voice--ready');
        })
        .catch(function () {
          if (token !== pregen.token) return;
          failed++;
          markReady(item, null);
        })
        .then(function () {
          if (token !== pregen.token) return;
          step(idx + 1);
        });
    }
    step(0);
  }

  function stopPregen() {
    pregen.running = false;
    pregen.token++;
    Array.prototype.forEach.call(document.querySelectorAll('.voice--pregen'), function (el) {
      el.classList.remove('voice--pregen');
    });
    if (!queue.running) np.bar.hidden = true;
  }

  /* startFrom: optional voice key to begin at — everything before it is skipped,
     so "▶ odtud" resumes a long sweep instead of restarting it. */
  function startQueue(items, startFrom) {
    if (!els.text.value.trim()) { toast('Nejdřív napiš větu.', true); return; }
    if (!items.length) { toast('Žádné hlasy k přehrání (zkontroluj filtr).', true); return; }
    stopQueue();
    queue.items = items;
    queue.running = true;
    queue.token++;

    var at = -1;
    if (startFrom) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].key === startFrom) { at = i - 1; break; }
      }
      if (at === -1 && items[0] && items[0].key !== startFrom) {
        // the chosen voice is filtered out of the run — say so rather than
        // silently starting from the top
        toast('Tenhle hlas filtr nepropouští, spouštím od začátku.', true);
      }
    }
    queue.i = at;
    items.forEach(function (it) { markRow(it, 'voice--queued'); });
    nextInQueue(1);
  }

  function stopQueue() {
    queue.running = false;
    queue.token++;
    stopAudio();
    npHide();
  }

  function nextInQueue(step) {
    if (!queue.running) return;
    // Bump the token on every advance, not just on stop: skipping must orphan the
    // previous item's promise chain. Otherwise a cancelled utterance that still
    // fires onend would advance the queue a second time and skip a voice.
    var token = ++queue.token;
    queue.i += (step === undefined ? 1 : step);
    if (queue.i >= queue.items.length || queue.i < 0) { stopQueue(); return; }

    var item = queue.items[queue.i];
    clearMarks();
    queue.items.forEach(function (it, idx) {
      if (idx > queue.i) markRow(it, 'voice--queued');
    });
    markRow(item, 'voice--playing');
    if (item.row && item.row.scrollIntoView) {
      item.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    npShow(item, 'generuji…', true);

    fetchClip(item)
      .then(function (clip) {
        if (token !== queue.token) return;              // superseded by stop/skip
        npShow(item, 'hraje', false);

        // Kick off the NEXT voice now, so it generates while this one plays.
        var ahead = queue.items[queue.i + 1];
        if (ahead) fetchClip(ahead).catch(function () {});

        if (clip.browser) return speakBrowser(item.v, els.text.value.trim());
        return play(clip);
      })
      .then(function () {
        if (token !== queue.token) return;
        nextInQueue(1);
      })
      .catch(function (err) {
        if (token !== queue.token) return;
        toast(item.label + ': ' + (err && err.message ? err.message : 'chyba'), true);
        nextInQueue(1);                                  // one bad voice must not stall the run
      });
  }

  /* Only voices currently passing the filter, in display order — so a run follows
     what you can actually see rather than a hidden full list. */
  function collectVoices(providerId) {
    var out = [];
    catalogue.forEach(function (e) {
      if (!e.configured || e.error) return;
      if (providerId && e.provider !== providerId) return;
      e.voices.forEach(function (v) {
        var k = vkey(e.provider, v.id);
        if (!passesFilter(k)) return;
        out.push({
          p: e.provider, v: v.id, label: v.label, key: k,
          row: document.getElementById('row-' + k.replace(/\W/g, '_')),
        });
      });
    });
    return out;
  }

  // ------------------------------------------------------------------ filter

  function passesFilter(k) {
    var stars = store.ratings[k] || 0;
    var want = els.fStars.value;
    if (want === 'unrated') { if (stars > 0) return false; }
    else if (Number(want) > 0 && stars < Number(want)) return false;

    var tag = store.tags[k];
    var g = els.fGender.value;
    if (g === 'untagged') { if (tag) return false; }
    else if (g && tag !== g) return false;

    return true;
  }

  function applyFilter() {
    var shown = 0, total = 0;
    catalogue.forEach(function (e) {
      if (!e.configured || e.error) return;
      e.voices.forEach(function (v) {
        var k = vkey(e.provider, v.id);
        var row = document.getElementById('row-' + k.replace(/\W/g, '_'));
        if (!row) return;
        total++;
        var ok = passesFilter(k);
        row.hidden = !ok;
        if (ok) shown++;
      });
    });
    els.filterCount.textContent =
      shown === total ? total + ' hlasů' : shown + ' z ' + total + ' hlasů';
  }

  // ------------------------------------------------------------- blind test

  var blind = { pool: [], pair: null, round: 0, total: 0, score: {} };

  function allVoices() {
    var out = [];
    catalogue.forEach(function (e) {
      if (!e.configured || e.error) return;
      e.voices.forEach(function (v) { out.push({ p: e.provider, v: v.id, label: v.label }); });
    });
    return out;
  }

  function startBlind() {
    var pool = allVoices();
    // Prefer voices you have already shown interest in; otherwise use everything.
    var rated = pool.filter(function (x) { return store.ratings[vkey(x.p, x.v)] > 0; });
    if (rated.length >= 2) pool = rated;
    if (pool.length < 2) { toast('Potřebuji aspoň dva hlasy.', true); return; }

    blind.pool = pool;
    blind.score = {};
    blind.round = 0;
    blind.total = Math.min(8, pool.length * 2);
    document.getElementById('blindResult').textContent = '';
    document.getElementById('blind').hidden = false;
    nextPair();
  }

  function nextPair() {
    if (blind.round >= blind.total) return finishBlind();
    blind.round++;
    var a = Math.floor(Math.random() * blind.pool.length);
    var b = a;
    while (b === a) b = Math.floor(Math.random() * blind.pool.length);
    blind.pair = [blind.pool[a], blind.pool[b]];
    document.getElementById('blindProgress').textContent =
      'Kolo ' + blind.round + ' z ' + blind.total + ' — poslechni obě, pak vyber.';
  }

  function playSide(i) {
    if (!blind.pair) return;
    var x = blind.pair[i];
    playVoice(x.p, x.v, null).catch(function () {});
  }

  function pick(which) {
    if (!blind.pair) return;
    if (which !== 'tie') {
      var win = blind.pair[which === 'a' ? 0 : 1];
      var k = vkey(win.p, win.v);
      blind.score[k] = (blind.score[k] || 0) + 1;
    }
    stopAudio();
    nextPair();
  }

  function finishBlind() {
    var ranked = Object.keys(blind.score).sort(function (a, b) { return blind.score[b] - blind.score[a]; });
    var box = document.getElementById('blindResult');
    box.innerHTML = '';
    if (!ranked.length) { box.textContent = 'Bez vítěze.'; return; }
    var h = document.createElement('strong');
    h.textContent = 'Výsledek';
    box.appendChild(h);
    ranked.slice(0, 5).forEach(function (k) {
      var d = document.createElement('div');
      d.textContent = blind.score[k] + '× — ' + k.replace('::', ' / ');
      box.appendChild(d);
    });
    blind.pair = null;
    document.getElementById('blindProgress').textContent = 'Hotovo.';
  }

  // -------------------------------------------------------------- bootstrap

  function browserEntry() {
    var voices = [];
    if (window.speechSynthesis) {
      voices = speechSynthesis.getVoices()
        .filter(function (v) { return /^cs/i.test(v.lang); })
        .map(function (v) {
          return { id: v.name, label: v.name, gender: '', note: v.localService ? 'lokální' : 'online' };
        });
    }
    return {
      provider: 'browser',
      label: 'Prohlížeč (výchozí stav)',
      hint: 'To, co Kacey používá teď — bez klíče a zdarma. Referenční bod, proti kterému měříš zbytek.',
      configured: true,
      controls: [],
      voices: voices,
    };
  }

  /* Windows ships exactly one Czech voice (Jakub, male, 2015-era engine), so with
     no API key there is literally nothing to compare. Say so plainly instead of
     showing a lone voice and letting the user wonder what broke. */
  function emptyStateBanner() {
    var cloud = catalogue.filter(function (e) { return e.provider !== 'browser'; });
    if (cloud.some(function (e) { return e.configured && !e.error; })) return null;

    var box = document.createElement('div');
    box.className = 'notice';

    var h = document.createElement('strong');
    h.textContent = 'Zatím není co porovnávat.';
    box.appendChild(h);

    var p = document.createElement('p');
    p.textContent =
      'Windows má jediný český hlas — Jakub, mužský, na starém enginu z roku 2015. ' +
      'Kacey je žena, takže tenhle hlas stejně nesedí. ' +
      'Nejrychlejší cesta k porovnání bez jakéhokoli klíče je lokální XTTS — ' +
      'stačí spustit jeho Python server. Cloudoví poskytovatelé níže potřebují klíč.';
    box.appendChild(p);

    var pre = document.createElement('pre');
    pre.className = 'setup';
    pre.textContent = '.venv-xtts\\Scripts\\python.exe voicelab/xtts_server.py';
    box.appendChild(pre);

    var after = document.createElement('p');
    after.className = 'small';
    after.textContent =
      'Až server naběhne (načtení modelu trvá desítky sekund), klikni na ' +
      '„Načíst hlasy znovu“ nahoře.';
    box.appendChild(after);

    return box;
  }

  function render() {
    els.providers.innerHTML = '';
    var banner = emptyStateBanner();
    if (banner) els.providers.appendChild(banner);
    catalogue.forEach(function (e) { els.providers.appendChild(providerCard(e)); });
    applyFilter();
    renderShortlist();
  }

  function refresh() {
    els.providers.innerHTML = '<p class="muted">Načítám hlasy…</p>';
    Promise.all([
      fetch('/api/providers').then(function (r) { return r.json(); }),
      fetch('/api/voices').then(function (r) { return r.json(); }),
    ])
      .then(function (res) {
        var meta = {};
        res[0].providers.forEach(function (p) { meta[p.id] = p; });
        catalogue = [browserEntry()].concat(
          res[1].results.map(function (r) {
            var m = meta[r.provider] || {};
            return {
              provider: r.provider,
              label: m.label || r.provider,
              hint: m.hint,
              configured: r.configured,
              missingEnv: r.missingEnv || m.missingEnv || [],
              controls: m.controls || [],
              error: r.error,
              voices: r.voices || [],
            };
          }),
        );
        render();
      })
      .catch(function (err) {
        els.providers.innerHTML = '';
        toast('Server neodpovídá: ' + err.message, true);
      });
  }

  els.text.oninput = function () {
    updateCount();
    queue.clips = {};          // cached clips belong to the old sentence
    stopPregen();
    Array.prototype.forEach.call(document.querySelectorAll('.voice--ready'), function (el) {
      el.classList.remove('voice--ready');
    });
    save();                    // remember the sentence too
  };
  els.reloadBtn.onclick = refresh;
  els.blindBtn.onclick = startBlind;
  document.getElementById('playAllBtn').onclick = function () {
    startQueue(collectVoices(null));
  };
  document.getElementById('pregenBtn').onclick = function () {
    if (pregen.running) { stopPregen(); toast('Předgenerování zastaveno.'); return; }
    startPregen(collectVoices(null));
  };
  document.getElementById('npStop').onclick = function () { stopPregen(); stopQueue(); };
  document.getElementById('npSkip').onclick = function () { stopAudio(); nextInQueue(1); };
  document.getElementById('npPrev').onclick = function () { stopAudio(); nextInQueue(-1); };

  // Space pauses the run, arrows step through it — but never while typing.
  document.addEventListener('keydown', function (ev) {
    if (!queue.running) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); stopAudio(); nextInQueue(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stopAudio(); nextInQueue(-1); }
    else if (ev.key === 'Escape') { ev.preventDefault(); stopQueue(); }
  });
  document.getElementById('blindClose').onclick = function () {
    document.getElementById('blind').hidden = true; stopAudio();
  };
  document.getElementById('sideA').onclick = function () { playSide(0); };
  document.getElementById('sideB').onclick = function () { playSide(1); };
  document.getElementById('pickA').onclick = function () { pick('a'); };
  document.getElementById('pickB').onclick = function () { pick('b'); };
  document.getElementById('pickTie').onclick = function () { pick('tie'); };

  els.fStars.onchange = function () { applyFilter(); renderShortlist(); };
  els.fGender.onchange = applyFilter;

  presetChips();
  // Pull the saved copy before drawing, so ratings and tags are present on the
  // very first render rather than appearing a beat later.
  loadRemote().then(refresh, refresh);

  /* ?autoplay=<provider> starts a run on load. Exists so a headless browser —
     which cannot click — can capture the queue mid-flight. Harmless otherwise. */
  (function () {
    var m = /[?&]autoplay=([\w-]+)/.exec(location.search);
    if (!m) return;
    setTimeout(function () { startQueue(collectVoices(m[1])); }, 2500);
  })();
  // getVoices() is usually empty on first call — redraw once the list lands.
  if (window.speechSynthesis) {
    speechSynthesis.addEventListener('voiceschanged', function () {
      if (catalogue.length) { catalogue[0] = browserEntry(); render(); }
    }, { once: true });
  }
})();
