/**
 * Kacey — the phone's notifications.
 *
 * The Android app's NotificationRelayService reads every notification the
 * phone shows and posts it here (POST /api/notify). Nothing in this file talks
 * to Instagram or any other service: the apps on the phone receive their own
 * notifications exactly as before, and Kacey only gets a copy from the phone's
 * notification shade. That is the whole point — an account that is never
 * logged into from anywhere new has nothing for an anti-automation system to
 * notice (a bridge like Beeper's logs in from a server, and gets flagged).
 *
 * One row per thing said, not per Android notification. A messaging app
 * (Instagram, WhatsApp) updates ONE notification again and again with the
 * whole recent conversation in it, so the phone sends each message of a
 * MessagingStyle notification as its own item, and `dedupe_key` makes
 * receiving the same message twice — the next update, a catch-up after the
 * listener reconnects, a retry from the phone's queue — a no-op.
 *
 * Sensitivity follows db.js: a notification the app marked secret, or one
 * that looks like a login code, is `local_only`. It is stored and shown, but
 * never handed to the model (summaries, Kacey's tool) — it would not leave
 * the machine any other way either.
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import { open, now, kvGet, kvSet } from './db.js';
import { NOTIFY_KEEP_DAYS } from './config.js';

export const INSTAGRAM = 'com.instagram.android';

/* ---- what the phone sends --------------------------------------------------- */

const text = (max) => z.string().max(max * 4).transform((s) => s.slice(0, max)).optional().nullable();

const ItemSchema = z.object({
  key: text(400),                 // StatusBarNotification.key, for removals
  package: z.string().min(1).max(200),
  app: text(120),                 // the app's label as the phone names it
  channel: text(200),
  category: text(60),
  posted_at: z.number().int().positive(),       // epoch ms
  title: text(300),
  text: text(4000),
  sub_text: text(300),
  conversation: text(300),        // MessagingStyle conversation title (groups)
  sender: text(300),              // MessagingStyle message sender
  group: z.boolean().optional(),
  message: z.boolean().optional(),              // one message of a MessagingStyle notification
  secret: z.boolean().optional(),               // visibility VISIBILITY_SECRET
});

const RemovalSchema = z.object({
  key: z.string().min(1).max(400),
  reason: z.number().int().optional(),          // NotificationListenerService.REASON_*
  at: z.number().int().positive().optional(),
});

export const IngestSchema = z.object({
  device: z.string().max(60).optional(),
  items: z.array(ItemSchema).max(500).optional(),
  removed: z.array(RemovalSchema).max(500).optional(),
});

/* ---- classification ----------------------------------------------------------- */

/* "Your code is 482913", "Kód pro přihlášení: 4829". Android 15 already
   redacts most of these before a listener sees them; this catches the rest. */
const CODE_RE = /(code|kód|kod|heslo|password|otp|verification|ověřovací|pin)\D{0,40}\b\d{4,8}\b|\b\d{4,8}\b\D{0,30}(is your|je váš|je tvůj)/i;

/** 'message' for something a person wrote you; 'notification' for the rest. */
export function kindOf(item) {
  if (item.message) return 'message';
  // Messaging apps that do not use MessagingStyle still say so in the channel.
  if (/direct|\bdm\b|message|chat|zpráv/i.test(item.channel || '') || item.category === 'msg') return 'message';
  return 'notification';
}

export function sensitivityOf(item) {
  if (item.secret) return 'local_only';
  if (CODE_RE.test(`${item.title || ''} ${item.text || ''}`)) return 'local_only';
  return 'cloud_safe';
}

/* What one row is about: the group's name, else the person who wrote, else
   the notification's title. For Instagram this is the DM thread. */
function conversationOf(item) {
  return (item.conversation || item.sender || item.title || '').trim();
}

/* The same message must hash the same however it arrives. A message's time
   is its own (MessagingStyle), so it is part of the key; a plain notification
   is the same one when the app re-posts it with the same words. */
function dedupeKey(item) {
  const parts = item.message
    ? [item.package, conversationOf(item), item.sender || '', item.posted_at, item.text || '']
    : [item.package, item.key || '', item.title || '', item.text || ''];
  return createHash('sha1').update(parts.join('␟')).digest('hex');
}

const newId = () => 'nt_' + randomBytes(9).toString('base64url');

/* ---- writing -------------------------------------------------------------------- */

/**
 * Store what the phone sent. Returns the rows that were new (the page is told
 * about those) and counts of the rest.
 */
export function ingest(body) {
  const parsed = IngestSchema.parse(body || {});
  const h = open();
  const device = parsed.device || 'phone';
  const stamp = now();
  const fresh = [];
  let duplicate = 0;
  let removed = 0;

  const insert = h.prepare(
    `INSERT INTO kacey_notification
       (notif_id, dedupe_key, device, package, app_label, channel, category, android_key,
        kind, conversation, is_group, sender, title, body, sub_text, posted_at, received_at,
        sensitivity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  );
  const markRemoved = h.prepare(
    `UPDATE kacey_notification SET removed_at = ?, removed_reason = ?, updated_at = ?
      WHERE android_key = ? AND removed_at IS NULL`,
  );

  h.exec('BEGIN IMMEDIATE');
  try {
    for (const item of parsed.items || []) {
      if (!item.title && !item.text) continue;
      const row = {
        notif_id: newId(),
        package: item.package,
        app_label: item.app || item.package,
        kind: kindOf(item),
        conversation: conversationOf(item),
        sender: item.sender || null,
        title: item.title || '',
        body: item.text || '',
        posted_at: new Date(item.posted_at).toISOString(),
        sensitivity: sensitivityOf(item),
      };
      const out = insert.run(
        row.notif_id, dedupeKey(item), device, row.package, row.app_label,
        item.channel || null, item.category || null, item.key || null,
        row.kind, row.conversation, item.group ? 1 : 0, row.sender, row.title, row.body,
        item.sub_text || null, row.posted_at, stamp, row.sensitivity, stamp, stamp,
      );
      if (out.changes) fresh.push(row);
      else duplicate++;
    }
    /* A phone that could not see an app's name sent its package instead
       (Android 11+ package visibility); the first real name fixes those. */
    const named = new Map((parsed.items || []).filter((i) => i.app && i.app !== i.package).map((i) => [i.package, i.app]));
    const rename = h.prepare(
      'UPDATE kacey_notification SET app_label = ?, updated_at = ? WHERE package = ? AND app_label = package',
    );
    for (const [pkg, label] of named) rename.run(label, stamp, pkg);
    for (const r of parsed.removed || []) {
      const at = new Date(r.at || Date.now()).toISOString();
      removed += markRemoved.run(at, r.reason ?? null, stamp, r.key).changes;
    }
    h.exec('COMMIT');
  } catch (err) {
    try { h.exec('ROLLBACK'); } catch { /* the BEGIN never took */ }
    throw err;
  }

  purgeOld();
  return { fresh, duplicate, removed };
}

/** Mark rows read in Kacey: by id, by app (and conversation), or everything. */
export function markRead({ ids, package: pkg, conversation, all } = {}) {
  const h = open();
  const stamp = now();
  if (Array.isArray(ids) && ids.length) {
    const list = ids.filter((id) => /^nt_[A-Za-z0-9_-]{6,30}$/.test(String(id))).slice(0, 500);
    if (!list.length) return 0;
    return h.prepare(
      `UPDATE kacey_notification SET read_at = ?, updated_at = ?
        WHERE read_at IS NULL AND notif_id IN (${list.map(() => '?').join(',')})`,
    ).run(stamp, stamp, ...list).changes;
  }
  if (pkg) {
    return conversation != null
      ? h.prepare(`UPDATE kacey_notification SET read_at = ?, updated_at = ?
                    WHERE read_at IS NULL AND package = ? AND conversation = ?`).run(stamp, stamp, pkg, conversation).changes
      : h.prepare(`UPDATE kacey_notification SET read_at = ?, updated_at = ?
                    WHERE read_at IS NULL AND package = ?`).run(stamp, stamp, pkg).changes;
  }
  if (all) {
    return h.prepare('UPDATE kacey_notification SET read_at = ?, updated_at = ? WHERE read_at IS NULL').run(stamp, stamp).changes;
  }
  return 0;
}

/* Keep NOTIFY_KEEP_DAYS of history. Checked at most once an hour, from
   ingest, so there is no timer of its own. */
let lastPurge = 0;
export function purgeOld(at = Date.now()) {
  if (at - lastPurge < 3600000) return 0;
  lastPurge = at;
  const cutoff = new Date(at - NOTIFY_KEEP_DAYS * 86400000).toISOString();
  return open().prepare('DELETE FROM kacey_notification WHERE posted_at < ?').run(cutoff).changes;
}

/* ---- reading -------------------------------------------------------------------- */

/** A row as the API hands it out. */
function present(r) {
  return {
    id: r.notif_id,
    package: r.package,
    app: r.app_label,
    kind: r.kind,
    conversation: r.conversation,
    group: r.is_group === 1,
    sender: r.sender,
    title: r.title,
    text: r.body,
    sub_text: r.sub_text,
    posted_at: r.posted_at,
    read: !!r.read_at,
    removed: !!r.removed_at,
    sensitive: r.sensitivity === 'local_only',
  };
}

/** Newest first. `before` (ISO) pages back; `unread` keeps only unread rows. */
export function list({ package: pkg, kind, unread, since, before, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (pkg) { where.push('package = ?'); args.push(pkg); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (unread) where.push('read_at IS NULL');
  if (since) { where.push('posted_at >= ?'); args.push(since); }
  if (before) { where.push('posted_at < ?'); args.push(before); }
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return open().prepare(
    `SELECT * FROM kacey_notification ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY posted_at DESC, created_at DESC LIMIT ${n}`,
  ).all(...args).map(present);
}

/** One line per app: how many, how many unread, the latest. Busiest unread first. */
export function apps({ since } = {}) {
  const rows = open().prepare(
    `SELECT package, MAX(app_label) AS app, COUNT(*) AS total,
            SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
            SUM(CASE WHEN kind = 'message' THEN 1 ELSE 0 END) AS messages,
            MAX(posted_at) AS last_at
       FROM kacey_notification ${since ? 'WHERE posted_at >= ?' : ''}
      GROUP BY package
      ORDER BY unread DESC, last_at DESC`,
  ).all(...(since ? [since] : []));
  return rows.map((r) => ({
    package: r.package, app: r.app, total: r.total, unread: r.unread, messages: r.messages, last_at: r.last_at,
  }));
}

/** An app's conversations (Instagram's DM threads), latest first. */
export function threads(pkg = INSTAGRAM, { limit = 60 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 60));
  const rows = open().prepare(
    `SELECT conversation, MAX(is_group) AS is_group, COUNT(*) AS total,
            SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
            MAX(posted_at) AS last_at
       FROM kacey_notification
      WHERE package = ? AND kind = 'message'
      GROUP BY conversation
      ORDER BY last_at DESC LIMIT ${n}`,
  ).all(pkg);
  const lastOf = open().prepare(
    `SELECT * FROM kacey_notification WHERE package = ? AND kind = 'message' AND conversation = ?
      ORDER BY posted_at DESC LIMIT 1`,
  );
  return rows.map((r) => ({
    conversation: r.conversation,
    group: r.is_group === 1,
    total: r.total,
    unread: r.unread,
    last_at: r.last_at,
    last: present(lastOf.get(pkg, r.conversation)),
  }));
}

/** One conversation, oldest first — the order it is read in. */
export function thread(pkg, conversation, { limit = 200 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  return open().prepare(
    `SELECT * FROM (
       SELECT * FROM kacey_notification WHERE package = ? AND kind = 'message' AND conversation = ?
        ORDER BY posted_at DESC LIMIT ${n})
      ORDER BY posted_at ASC`,
  ).all(pkg, conversation).map(present);
}

export function unreadCounts() {
  const r = open().prepare(
    `SELECT COUNT(*) AS all_unread,
            SUM(CASE WHEN package = ? AND kind = 'message' THEN 1 ELSE 0 END) AS dm_unread
       FROM kacey_notification WHERE read_at IS NULL`,
  ).get(INSTAGRAM);
  return { all: r.all_unread || 0, dm: r.dm_unread || 0 };
}

/* ---- for the model ------------------------------------------------------------- */

const clock = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One row as the model reads it. Sensitive ones say only that they exist. */
export function describe(n) {
  const who = n.kind === 'message'
    ? (n.group && n.sender && n.sender !== n.conversation ? `${n.sender} v „${n.conversation}“` : n.sender || n.conversation)
    : n.title;
  const what = n.sensitive ? '[citlivé — obsah se nepředává]' : (n.kind === 'message' ? n.text : [n.title === who ? '' : n.title, n.text].filter(Boolean).join(' — '));
  return `- ${clock(n.posted_at)} · ${n.app} · ${who || '(bez názvu)'}: ${what}${n.read ? '' : ' [nepřečteno]'}`;
}

const SUMMARY_SYSTEM = [
  'Shrnuješ oznámení z telefonu pro jeho majitele. Píšeš česky, stručně, bez markdownu,',
  'bez odrážek a bez emoji, protože se shrnutí může i číst nahlas.',
  'Nejdřív to, co od něj někdo chce nebo na co čeká odpověď (zprávy od lidí), pak důležité',
  'od aplikací (doprava, platby, termíny), a nakonec jednou větou zbytek („plus 14 oznámení',
  'ze Spotify a YouTube“). Reklamu a upozornění bez obsahu jen spočítej. Nevymýšlej si nic,',
  'co v oznámeních není. U zpráv řekni kdo a o co jde, necituj celé zprávy.',
  'Řádky označené jako citlivé jen zmiň („a jeden přihlašovací kód“), nikdy je nehádej.',
  'Nanejvýš šest vět.',
].join(' ');

const DM_SYSTEM = [
  'Shrnuješ soukromé zprávy z Instagramu pro jejich adresáta, aby nemusel otevírat aplikaci.',
  'Česky, stručně, bez markdownu a emoji. Po konverzacích: kdo píše, co chce, a jestli čeká',
  'odpověď. Nejdřív ty, které na odpověď čekají. Necituj celé zprávy a nic si nedomýšlej.',
  'Nanejvýš jedna až dvě věty na konverzaci.',
].join(' ');

/**
 * A model-written summary of the unread notifications (scope 'all') or of the
 * unread Instagram DMs (scope 'dm'). Cached by what it summarised, so opening
 * the page twice costs one call, and a new notification makes it stale.
 * `runner` is dream.js's makeSdkRunner() or a test double.
 */
export async function summarize({ scope = 'all', runner, force = false } = {}) {
  const rows = scope === 'dm'
    ? list({ package: INSTAGRAM, kind: 'message', unread: true, limit: 200 })
    : list({ unread: true, limit: 300 });
  if (!rows.length) return { scope, count: 0, text: '', generated_at: now(), cached: false };

  const basis = createHash('sha1').update(rows.map((r) => r.id).join(',')).digest('hex');
  const cacheKey = `notify.summary.${scope}`;
  const cached = kvGet(cacheKey, null);
  if (!force && cached && cached.basis === basis) return { ...cached.out, cached: true };

  const prompt = (scope === 'dm' ? 'Nepřečtené zprávy z Instagramu' : 'Nepřečtená oznámení') +
    `, nejnovější nahoře (${rows.length}):\n` + rows.map(describe).join('\n');
  const textOut = String(await runner({ system: scope === 'dm' ? DM_SYSTEM : SUMMARY_SYSTEM, prompt })).trim();
  const out = { scope, count: rows.length, text: textOut, generated_at: now() };
  kvSet(cacheKey, { basis, out });
  return { ...out, cached: false };
}
