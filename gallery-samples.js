/**
 * Kacey — sample photos for the gallery, in a preview only.
 *
 * A preview of the gallery branch starts from a copy of the database with no
 * photos in it, which shows nothing of the grid, the tags or the search. So a
 * preview (KACEY_PREVIEW=1) with an empty gallery gets eight painted scenes
 * with the kind of descriptions Kacey writes. The running app never does.
 *
 * The scenes are drawn pixel by pixel and encoded as PNG with node:zlib —
 * nothing to install, nothing checked into the repository.
 */

import { deflateSync } from 'node:zlib';

import * as gallery from './gallery.js';
import { open } from './db.js';

const W = 640, H = 480;

/* ---- a minimal PNG encoder --------------------------------------------------- */

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(paint) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x / W, y / H, x, y);
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = clamp(r); raw[o + 1] = clamp(g); raw[o + 2] = clamp(b);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- painting helpers ---------------------------------------------------------- */

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t)));
const noise = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const grain = (c, x, y, amt = 8) => { const n = (noise(x, y) - 0.5) * amt; return c.map((v) => v + n); };
const ridge = (u, seed, amp, base) => base - amp * (0.55 * Math.sin(u * 6.3 + seed) + 0.3 * Math.sin(u * 13.1 + seed * 2) + 0.15 * Math.sin(u * 29 + seed * 3));

/* ---- the scenes ----------------------------------------------------------------------- */

const SCENES = [
  {
    days: 2, source: 'chat', name: 'IMG_4127.jpg',
    meta: {
      title: 'Západ slunce nad Lipnem',
      caption: 'Slunce zapadá nad klidnou hladinou přehrady, obloha hraje do oranžova a fialova, v dálce tmavé kopce.',
      tags: ['západ slunce', 'lipno', 'voda', 'léto'],
      keywords: ['přehrada', 'jezero', 'večer', 'obloha', 'oranžová', 'fialová', 'krajina', 'příroda', 'venku', 'dovolená', 'šumava', 'hladina', 'slunce'],
    },
    paint(u, v, x, y) {
      const sky = mix([58, 42, 92], [255, 150, 70], v / 0.58);
      const hill = ridge(u, 1.3, 0.035, 0.56);
      const sun = Math.hypot((u - 0.62) * 1.33, v - 0.5);
      if (v < hill) return grain(sun < 0.07 ? [255, 222, 140] : mix(sky, [255, 200, 120], 1 - sun * 4), x, y, 4);
      if (v < 0.585) return [40, 26, 48];
      const water = mix([90, 60, 90], [24, 30, 60], (v - 0.58) / 0.42);
      const glow = Math.exp(-((u - 0.62) ** 2) / 0.002) * (0.5 + 0.5 * Math.sin(v * 180 + u * 9));
      return grain(mix(water, [255, 170, 90], glow * 0.8), x, y, 6);
    },
  },
  {
    days: 41, source: 'gallery', name: 'DSC_0912.jpg',
    meta: {
      title: 'Zasněžené hřebeny v Krkonoších',
      caption: 'Pohled přes zasněžené horské hřebeny pod jasně modrou oblohou, vrstvy kopců mizí do oparu.',
      tags: ['hory', 'sníh', 'krkonoše', 'výlet'],
      keywords: ['zima', 'leden', 'únor', 'horská krajina', 'vrcholky', 'modrá obloha', 'příroda', 'venku', 'turistika', 'lyžování', 'bílá', 'chata', 'hřeben'],
    },
    paint(u, v, x, y) {
      const sky = mix([70, 130, 210], [190, 220, 245], v / 0.5);
      const r1 = ridge(u, 0.4, 0.08, 0.42), r2 = ridge(u, 2.2, 0.07, 0.55), r3 = ridge(u, 4.1, 0.05, 0.72);
      if (v < r1) return grain(sky, x, y, 3);
      if (v < r2) return grain(mix([150, 165, 190], [235, 240, 248], (r1 + 0.05 - v) * 12), x, y, 5);
      if (v < r3) return grain(mix([110, 125, 150], [245, 248, 252], (r2 + 0.06 - v) * 9), x, y, 6);
      return grain(mix([250, 252, 255], [200, 212, 230], (v - r3) * 2), x, y, 7);
    },
  },
  {
    days: 96, source: 'gallery', name: 'IMG_3301.jpg',
    meta: {
      title: 'Pole vlčích máků u Kutné Hory',
      caption: 'Louka plná rozkvetlých červených máků pod světlou letní oblohou.',
      tags: ['květiny', 'mák', 'louka', 'léto'],
      keywords: ['vlčí mák', 'pole', 'červená', 'zelená', 'příroda', 'venku', 'červen', 'kytky', 'krajina', 'venkov', 'procházka'],
    },
    paint(u, v, x, y) {
      if (v < 0.4) return grain(mix([150, 195, 235], [225, 235, 240], v / 0.4), x, y, 3);
      const depth = (v - 0.4) / 0.6;
      const cell = 6 + depth * 26;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const fx = x / cell - cx - 0.5, fy = y / cell - cy - 0.5;
      const isPoppy = noise(cx, cy) > 0.62 && Math.hypot(fx, fy) < 0.32;
      if (isPoppy) return grain([214 + depth * 20, 30, 28], x, y, 18);
      return grain(mix([120, 150, 70], [60, 110, 40], depth), x, y, 22);
    },
  },
  {
    days: 13, source: 'chat', name: 'screenshot-receipt.png',
    meta: {
      title: 'Účtenka z Alzy — sluchátka',
      caption: 'Pokladní doklad z Alzy za bezdrátová sluchátka, celkem 2 490 Kč, zaplaceno kartou.',
      tags: ['účtenka', 'alza', 'nákup', 'záruka'],
      keywords: ['doklad', 'paragon', 'faktura', 'elektronika', 'sluchátka', 'peníze', 'cena', 'reklamace', 'dokument', 'papír', 'text'],
    },
    paint(u, v, x, y) {
      const inPaper = u > 0.33 && u < 0.67 && v > 0.06 && v < 0.94;
      if (!inPaper) return grain(mix([120, 92, 70], [96, 72, 54], noise(Math.floor(y / 3), 1)), x, y, 10);
      const line = Math.floor((v - 0.1) / 0.045);
      const inLine = ((v - 0.1) % 0.045) < 0.016 && v > 0.1 && v < 0.88;
      const width = line === 0 ? 0.18 : line === 15 ? 0.27 : 0.12 + noise(line, 3) * 0.14;
      const right = u > 0.6 - (line % 3 === 0 ? 0.04 : 0) && u < 0.64 && line > 1 && line < 14;
      if (inLine && ((u > 0.36 && u < 0.36 + width) || right)) return line === 15 ? [30, 30, 30] : [95, 95, 95];
      return grain([246, 244, 238], x, y, 4);
    },
  },
  {
    days: 5, source: 'gallery', name: 'IMG_4090.jpg',
    meta: {
      title: 'Noční Praha z Letné',
      caption: 'Večerní panorama města, rozsvícená okna domů pod tmavě modrou oblohou.',
      tags: ['město', 'noc', 'praha', 'výhled'],
      keywords: ['letná', 'panorama', 'domy', 'světla', 'okna', 'večer', 'tma', 'architektura', 'venku', 'procházka', 'budovy'],
    },
    paint(u, v, x, y) {
      const col = Math.floor(u * 22);
      const top = 0.3 + noise(col, 7) * 0.35;
      if (v < top) return grain(mix([10, 14, 40], [40, 46, 90], v / 0.65), x, y, 3);
      const wx = (u * 22 - col) * 6, wy = (v - top) * 60;
      const lit = noise(col * 13 + Math.floor(wx), Math.floor(wy)) > 0.55;
      if ((wx % 1) > 0.45 && (wy % 1) > 0.45 && lit) return [255, 214, 120];
      return grain([22 + noise(col, 1) * 14, 22, 34], x, y, 4);
    },
  },
  {
    days: 22, source: 'gallery', name: 'IMG_3988.jpg',
    meta: {
      title: 'Podzimní bukový les',
      caption: 'Stezka v lese plném žlutého a oranžového listí, mezi stromy prosvítá světlo.',
      tags: ['les', 'podzim', 'procházka', 'stromy'],
      keywords: ['listí', 'buky', 'říjen', 'oranžová', 'žlutá', 'příroda', 'venku', 'stezka', 'turistika', 'barvy', 'kmeny'],
    },
    paint(u, v, x, y) {
      const leaf = mix([238, 170, 50], [190, 80, 30], noise(Math.floor(x / 9), Math.floor(y / 9)));
      const trunks = [0.12, 0.27, 0.46, 0.71, 0.88];
      for (const t of trunks) {
        const w = 0.012 + (t * 7 % 1) * 0.02;
        if (Math.abs(u - t - Math.sin(v * 3 + t) * 0.01) < w) return grain([70, 50, 38], x, y, 12);
      }
      if (v > 0.78) return grain(mix([170, 90, 40], [120, 60, 30], (v - 0.78) * 4), x, y, 26);
      return grain(mix(leaf, [255, 236, 170], Math.max(0, 0.5 - Math.hypot(u - 0.55, v - 0.35)) * 1.2), x, y, 16);
    },
  },
  {
    days: 130, source: 'gallery', name: 'IMG_2214.jpg',
    meta: {
      title: 'Pláž v Chorvatsku',
      caption: 'Tyrkysové moře s mírnými vlnami a světlá písečná pláž za slunečného dne.',
      tags: ['moře', 'pláž', 'dovolená', 'chorvatsko'],
      keywords: ['léto', 'srpen', 'voda', 'písek', 'vlny', 'tyrkysová', 'modrá', 'slunce', 'venku', 'koupání', 'cestování', 'pobřeží'],
    },
    paint(u, v, x, y) {
      if (v < 0.38) return grain(mix([90, 160, 230], [200, 228, 245], v / 0.38), x, y, 3);
      const shore = 0.72 + 0.04 * Math.sin(u * 7);
      if (v < shore) {
        const wave = 0.5 + 0.5 * Math.sin(v * 140 + Math.sin(u * 12) * 3);
        return grain(mix(mix([30, 110, 160], [60, 200, 200], (v - 0.38) / 0.34), [235, 250, 250], wave > 0.93 ? 0.6 : 0), x, y, 5);
      }
      return grain(mix([236, 214, 170], [210, 186, 140], (v - shore) * 3), x, y, 14);
    },
  },
  {
    days: 0, source: 'chat', name: 'IMG_4133.jpg',
    meta: {
      title: 'Ranní káva na stole',
      caption: 'Hrnek černé kávy na dřevěném stole, shora, v měkkém ranním světle.',
      tags: ['káva', 'ráno', 'doma', 'jídlo'],
      keywords: ['hrnek', 'kafe', 'snídaně', 'stůl', 'dřevo', 'pití', 'uvnitř', 'byt', 'hnědá', 'pohoda'],
    },
    paint(u, v, x, y) {
      const d = Math.hypot((u - 0.5) * 1.33, v - 0.5);
      if (d < 0.17) return grain(mix([60, 34, 20], [110, 66, 36], d / 0.17), x, y, 6);
      if (d < 0.2) return grain([240, 238, 232], x, y, 4);
      const handle = Math.hypot((u - 0.68) * 1.33, v - 0.5);
      if (handle > 0.035 && handle < 0.06 && u > 0.64) return grain([236, 234, 228], x, y, 4);
      if (d < 0.23) return [70, 52, 40];
      const plank = Math.floor(y / 60);
      return grain(mix([150, 104, 66], [118, 80, 50], 0.5 + 0.5 * Math.sin(u * 40 + plank * 3 + noise(plank, 2) * 6)), x, y, 12);
    },
  },
];

/** Paint and store the samples when a preview's gallery is empty. */
export async function seedSamples() {
  const n = open().prepare('SELECT COUNT(*) AS n FROM kacey_photo').get().n;
  if (n) return 0;
  // Oldest first, so the newest lands on top of the grid.
  const scenes = [...SCENES].sort((a, b) => b.days - a.days);
  for (const s of scenes) {
    const data = png(s.paint).toString('base64');
    const at = new Date(Date.now() - s.days * 86400000 - Math.round(noise(s.days, 9) * 8 * 3600000));
    await gallery.save({
      image: { media_type: 'image/png', data }, name: s.name, width: W, height: H,
      taken_at: at.toISOString(), source: s.source, meta: s.meta,
    });
  }
  return scenes.length;
}
