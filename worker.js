// API Padel pour Cloudflare Workers (appelée seulement pour /api/*).
// Stockage : base D1 (liaison "DB"). Mot de passe admin : variable ADMIN_PASSWORD.
// Version portée de api.mjs (Netlify) : mêmes routes, mêmes formats.

const TABLES = ['tournaments', 'pub'];
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function tokenFor(pw) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode('padel-admin-v1')));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/* ---- Comptes juges-arbitres : identifiant + mot de passe créés par l'administrateur ---- */
const LOGIN_RE = /^[a-z0-9_-]{2,24}$/;
async function hmacHex(pw, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
const judgeToken = async (pw, login, hash) => 'j.' + login + '.' + await hmacHex(pw, 'padel-judge-v1:' + login + ':' + hash);
/* Renvoie { role: 'admin' | 'judge', login, name } ou null */
async function auth(req, store, pw) {
  if (!pw) return null;
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  if (!t.includes('.')) return safeEqual(t, await tokenFor(pw)) ? { role: 'admin', login: 'admin', name: 'Administrateur' } : null;
  const [pfx, login, sig] = t.split('.');
  if (pfx !== 'j' || !LOGIN_RE.test(login || '') || !sig) return null;
  const user = await store.get('users/' + login);
  if (!user) return null;
  return safeEqual(sig, (await judgeToken(pw, login, user.hash)).split('.')[2]) ? { role: 'judge', login, name: user.name } : null;
}
async function isAdmin(req, store, pw) { const a = await auth(req, store, pw); return !!a && a.role === 'admin'; }
/* Propriétaire d'un tournoi : null s'il n'existe pas encore */
async function ownerOf(store, tid) {
  const t = await store.get('tournaments/' + tid).catch(() => null);
  if (t) return t.owner || 'admin';
  const p = await store.get('pub/' + tid).catch(() => null);
  return p ? (p.owner || 'admin') : null;
}
const canManage = async (a, store, tid) => !!a && (a.role === 'admin' || (await ownerOf(store, tid)) === a.login);
function stripContacts(raw) {
  try {
    const o = JSON.parse(raw);
    (o.pairs || []).forEach(p => ['a', 'b'].forEach(k => { if (p && p[k]) { p[k].email = ''; p[k].tel = ''; p[k].naissance = ''; } }));
    return JSON.stringify(o);
  } catch (e) { return ''; }
}

// Petit "magasin" clé/valeur au-dessus de D1 (table kv : key, value)
function makeStore(db) {
  // Crée la table au premier appel si elle n'existe pas encore
  const ready = db.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  const wrap = (f) => async (...a) => { await ready; return f(...a); };
  const raw = {
    async get(key) {
      const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
      return r ? JSON.parse(r.value) : null;
    },
    async setJSON(key, val) {
      await db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, JSON.stringify(val)).run();
    },
    async delete(key) { await db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run(); },
    async listJSON(prefix) {
      const { results } = await db.prepare('SELECT value FROM kv WHERE substr(key, 1, ?) = ?').bind(prefix.length, prefix).all();
      return results.map(r => { try { return JSON.parse(r.value); } catch (e) { return null; } }).filter(Boolean);
    }
  };
  return { get: wrap(raw.get), setJSON: wrap(raw.setJSON), delete: wrap(raw.delete), listJSON: wrap(raw.listJSON) };
}

/* ---- Mes Pronos : pronostics publics (un enregistrement par appareil) ---- */
const hashDev = async (dev) => (await sha256Hex('padel-dev:' + dev)).slice(0, 16);
function cleanPicks(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src).slice(0, 400)) {
    if (!/^[\w.]{1,12}$/.test(k)) continue;
    const p = src[k];
    if (k === 'W' || /^G\d{1,2}$/.test(k)) {
      if (p && typeof p.p === 'string' && /^[\w-]{1,24}$/.test(p.p)) out[k] = { p: p.p };
      continue;
    }
    if (!p || (p.w !== 'a' && p.w !== 'b') || typeof p.a !== 'string' || typeof p.b !== 'string' || p.a.length > 24 || p.b.length > 24) continue;
    let s = null;
    if (Array.isArray(p.s) && p.s.length === 2) {
      const x = Number(p.s[0]), y = Number(p.s[1]);
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= 99 && y <= 99 && ((p.w === 'a') === (x > y)) && x !== y) s = [x, y];
    }
    out[k] = { w: p.w, a: p.a, b: p.b, s };
  }
  return out;
}
async function lockedIds(store, tid) {
  const locked = new Set();
  try {
    const row = await store.get('pub/' + tid);
    if (row && row.json) {
      const st = JSON.parse(row.json);
      Object.keys(st.starts || {}).forEach(id => { if (st.starts[id]) locked.add(id); });
      Object.keys(st.scores || {}).forEach(id => { const v = st.scores[id]; if (v && (v.a !== '' && v.a != null || v.b !== '' && v.b != null)) locked.add(id); });
      /* vainqueur du tournoi / de poule : fermés dès que le premier match est lancé */
      if (locked.size) { locked.add('W'); for (let g = 1; g <= 40; g++) locked.add('G' + g); }
    }
  } catch (e) { /* pas de verrou si le tournoi n'est pas publié */ }
  return locked;
}

async function handle(req, store, pw, env) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && parts[0] === 'login') {
      const body = await req.json().catch(() => ({}));
      if (!pw) return json({ error: 'no_password_configured' }, 500);
      const given = typeof body.password === 'string' ? body.password.trim() : '';
      const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
      if (!login || login === 'admin') {
        if (safeEqual(given, pw)) return json({ token: await tokenFor(pw), role: 'admin', login: 'admin', name: 'Administrateur' });
        return json({ error: 'bad_password' }, 401);
      }
      const user = LOGIN_RE.test(login) ? await store.get('users/' + login) : null;
      if (user && safeEqual(await pbkdf2(given, user.salt), user.hash)) {
        return json({ token: await judgeToken(pw, login, user.hash), role: 'judge', login, name: user.name });
      }
      return json({ error: 'bad_password' }, 401);
    }
    /* envoi des convocations : un mail par paire depuis l'adresse globale, + un récapitulatif en copie */
    if (req.method === 'POST' && parts[0] === 'send-convocations') {
      const a = await auth(req, store, pw);
      if (!a) return json({ error: 'unauthorized' }, 401);
      if (!env || !env.EMAIL) return json({ error: 'email_not_configured' }, 501);
      const b = await req.json().catch(() => ({}));
      const EM = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
      const msgs = Array.isArray(b.messages) ? b.messages.slice(0, 40) : [];
      const copy = typeof b.copy === 'string' && EM.test(b.copy.trim()) ? b.copy.trim() : '';
      const FROM = { email: 'convocations@tournois-badpad.fr', name: 'Bad Pad – Convocations' };
      const sent = [], failed = [];
      for (const m of msgs) {
        const to = (Array.isArray(m.to) ? m.to : []).map(x => String(x).trim()).filter(x => EM.test(x)).slice(0, 4);
        const subject = String(m.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
        const text = String(m.text || '').slice(0, 8000);
        if (!to.length || !subject || !text) { failed.push({ to, code: 'invalid' }); continue; }
        try {
          const msg = { from: FROM, to, subject, text };
          if (copy) msg.replyTo = copy;
          await env.EMAIL.send(msg);
          sent.push(to);
        } catch (e) { failed.push({ to, code: (e && e.code) || 'error', message: String((e && e.message) || '').slice(0, 160) }); }
      }
      let copySent = false;
      if (copy && b.recap) {
        try {
          await env.EMAIL.send({ from: FROM, to: [copy], subject: String(b.recapSubject || 'Copie des convocations').slice(0, 200), text: String(b.recap).slice(0, 20000) });
          copySent = true;
        } catch (e) { /* la copie ne bloque pas l'envoi */ }
      }
      return json({ sent: sent.length, failed, copySent });
    }
    if (req.method === 'GET' && parts[0] === 'me') {
      const a = await auth(req, store, pw);
      return a ? json(a) : json({ error: 'unauthorized' }, 401);
    }
    /* gestion des juges : administrateur seulement */
    if (parts[0] === 'users') {
      if (!(await isAdmin(req, store, pw))) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'GET' && parts.length === 1) {
        const us = await store.listJSON('users/');
        return json(us.map(u => ({ login: u.login, name: u.name, created: u.created })).sort((x, y) => x.name.localeCompare(y.name)));
      }
      if (req.method === 'PUT' && LOGIN_RE.test(parts[1] || '') && parts[1] !== 'admin') {
        const b = await req.json().catch(() => ({}));
        const name = String(b.name || '').replace(/[<>&"\u0000-\u001f]/g, '').trim().slice(0, 40);
        const prev = await store.get('users/' + parts[1]);
        if (!name) return json({ error: 'name_required' }, 400);
        const password = typeof b.password === 'string' ? b.password.trim() : '';
        if (!prev && password.length < 6) return json({ error: 'password_too_short' }, 400);
        if (password && password.length < 6) return json({ error: 'password_too_short' }, 400);
        let salt = prev && prev.salt, hash = prev && prev.hash;
        if (password) {
          salt = hex(crypto.getRandomValues(new Uint8Array(16)));
          hash = await pbkdf2(password, salt);
        }
        await store.setJSON('users/' + parts[1], { login: parts[1], name, salt, hash, created: (prev && prev.created) || Date.now() });
        return json({ ok: true });
      }
      if (req.method === 'DELETE' && LOGIN_RE.test(parts[1] || '')) {
        await store.delete('users/' + parts[1]);
        return json({ ok: true });
      }
      return json({ error: 'not_found' }, 404);
    }
    /* attribuer un tournoi à un juge (ou le reprendre) : administrateur seulement */
    if (req.method === 'POST' && parts[0] === 'owner' && /^[\w-]{1,80}$/.test(parts[1] || '')) {
      if (!(await isAdmin(req, store, pw))) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({}));
      const owner = String(b.owner || '');
      if (owner !== 'admin' && !(LOGIN_RE.test(owner) && await store.get('users/' + owner))) return json({ error: 'unknown_user' }, 400);
      for (const t of TABLES) {
        const r = await store.get(t + '/' + parts[1]);
        if (r) await store.setJSON(t + '/' + parts[1], { ...r, owner });
      }
      return json({ ok: true });
    }
    if (req.method === 'GET' && parts[0] === 'list' && TABLES.includes(parts[1])) {
      const rows = await store.listJSON(parts[1] + '/');
      if (parts[1] === 'tournaments') {
        const a = await auth(req, store, pw);
        if (!a) return json({ error: 'unauthorized' }, 401);
        const names = {};
        (await store.listJSON('users/')).forEach(u => { names[u.login] = u.name; });
        return json(rows.map(r => {
          const owner = r.owner || 'admin';
          const mine = a.role === 'admin' || owner === a.login;
          return { ...r, owner, ownerName: owner === 'admin' ? 'Administrateur' : (names[owner] || owner), json: mine || r.deleted ? r.json : stripContacts(r.json) };
        }));
      }
      return json(rows.map(r => { const { owner, ...rest } = r; return rest; }));
    }
    if (req.method === 'PUT' && parts[0] === 'doc' && TABLES.includes(parts[1]) && /^[\w-]{1,80}$/.test(parts[2] || '')) {
      const a = await auth(req, store, pw);
      if (!a) return json({ error: 'unauthorized' }, 401);
      const cur = await ownerOf(store, parts[2]);
      if (a.role !== 'admin' && cur && cur !== a.login) return json({ error: 'forbidden' }, 403);
      const b = await req.json();
      const row = { id: parts[2], json: typeof b.json === 'string' ? b.json : '', up: Number(b.up) || 0, deleted: !!b.deleted, owner: cur || a.login };
      await store.setJSON(parts[1] + '/' + parts[2], row);
      return json({ ok: true });
    }
    if (parts[0] === 'vote' && /^[\w-]{1,80}$/.test(parts[1] || '') && /^[\w-]{8,64}$/.test(parts[2] || '')) {
      const tid = parts[1];
      if (req.method === 'PUT') {
        const raw = await req.text();
        if (raw.length > 40000) return json({ error: 'too_large' }, 413);
        const b = JSON.parse(raw || '{}');
        const h = await hashDev(parts[2]);
        const key = 'votes/' + tid + '/' + h;
        const name = String(b.name || '').replace(/[<>&"\u0000-\u001f]/g, '').trim().slice(0, 24);
        if (!name) return json({ error: 'name_required' }, 400);
        const prev = await store.get(key).catch(() => null);
        const old = (prev && prev.picks) || {};
        const mine = cleanPicks(b.picks);
        const locked = await lockedIds(store, tid);
        const picks = { ...old };
        for (const id of Object.keys(mine)) {
          const same = old[id] && JSON.stringify(old[id]) === JSON.stringify(mine[id]);
          if (!same && locked.has(id)) continue;
          picks[id] = mine[id];
        }
        for (const id of Object.keys(old)) { if (!(id in mine) && !locked.has(id)) delete picks[id]; }
        await store.setJSON(key, { h, name, picks, up: Date.now() });
        return json({ ok: true, h, picks });
      }
      if (req.method === 'DELETE' && /^[0-9a-f]{16}$/.test(parts[2])) {
        if (!(await canManage(await auth(req, store, pw), store, tid))) return json({ error: 'unauthorized' }, 401);
        await store.delete('votes/' + tid + '/' + parts[2]);
        return json({ ok: true });
      }
    }
    if (req.method === 'GET' && parts[0] === 'votes' && /^[\w-]{1,80}$/.test(parts[1] || '')) {
      const rows = await store.listJSON('votes/' + parts[1] + '/');
      const dev = url.searchParams.get('dev') || '';
      return json({ rows: rows.map(r => ({ h: r.h, name: r.name, picks: r.picks, up: r.up })), me: /^[\w-]{8,64}$/.test(dev) ? await hashDev(dev) : null });
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String(e && e.message || e) }, 500);
  }
}


export default {
  async fetch(request, env) {
    if (!env.DB) return json({ error: 'server', message: 'Liaison D1 "DB" manquante' }, 500);
    return handle(request, makeStore(env.DB), (env.ADMIN_PASSWORD || '').trim(), env);
  }
};
