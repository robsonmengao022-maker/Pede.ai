'use strict';
// Pedeaí - plataforma de delivery multi-lojas. Sem dependências externas (Node 22+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pedeai.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS stores(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, whatsapp TEXT DEFAULT '',
  address TEXT DEFAULT '', city TEXT DEFAULT '', pix_key TEXT DEFAULT '', pix_name TEXT DEFAULT '',
  accepts_pix INTEGER DEFAULT 0, accepts_cash INTEGER DEFAULT 1, accepts_card_delivery INTEGER DEFAULT 0,
  accepts_link INTEGER DEFAULT 0, payment_link TEXT DEFAULT '',
  delivery_fee REAL DEFAULT 0, min_order REAL DEFAULT 0, is_open INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, store_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL, category_id INTEGER, name TEXT NOT NULL,
  description TEXT DEFAULT '', price REAL NOT NULL, image_url TEXT DEFAULT '', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL, code TEXT NOT NULL,
  customer_name TEXT, phone TEXT, kind TEXT, address TEXT, notes TEXT, payment_method TEXT, change_for TEXT,
  items_json TEXT, subtotal REAL, delivery_fee REAL, total REAL, status TEXT DEFAULT 'novo',
  created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id, created_at);
`);

// ---------- Faixas de cobrança da plataforma (por faturamento mensal da loja) ----------
const FEE_TIERS = { freeUpTo: 7000, midUpTo: 10000, midFee: 69.9, topFee: 129.9 };
function monthlyFee(revenue) {
  if (revenue > FEE_TIERS.midUpTo) return FEE_TIERS.topFee;
  if (revenue > FEE_TIERS.freeUpTo) return FEE_TIERS.midFee;
  return 0;
}
const monthKey = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7); // horário de Brasília
function monthRevenue(storeId) {
  const r = db.prepare(`SELECT COALESCE(SUM(total),0) AS s, COUNT(*) AS n FROM orders
    WHERE store_id=? AND status!='cancelado' AND substr(datetime(created_at,'-3 hours'),1,7)=?`).get(storeId, monthKey());
  return { revenue: r.s, orders: r.n };
}

// ---------- Utilidades ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
const fail = (res, code, msg) => json(res, code, { error: msg });
function readBody(req) {
  return new Promise((ok, bad) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 200000) { req.destroy(); bad(new Error('Corpo muito grande')); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error('JSON inválido')); } });
    req.on('error', bad);
  });
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function hashPass(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPass(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hits = new Map();
function limited(req, key, max, windowMs) {
  const k = key + ':' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  const now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();
const slugify = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const RESERVED = new Set(['painel', 'admin', 'api', 'recibo', 'index', 'static']);
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = v => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const okUrl = u => { if (!u) return ''; try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ''; } catch { return ''; } };

function authStore(req) {
  const t = cookies(req).sid;
  if (!t) return null;
  const row = db.prepare(`SELECT s.* FROM sessions x JOIN stores s ON s.id=x.store_id WHERE x.token=?`).get(t);
  return row || null;
}
function startSession(res, storeId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,store_id) VALUES(?,?)').run(token, storeId);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
}
const publicStore = s => ({
  slug: s.slug, name: s.name, whatsapp: s.whatsapp, address: s.address, city: s.city, is_open: !!s.is_open,
  delivery_fee: s.delivery_fee, min_order: s.min_order,
  payments: {
    pix: !!(s.accepts_pix && s.pix_key), cash: !!s.accepts_cash, card_delivery: !!s.accepts_card_delivery,
    link: !!(s.accepts_link && s.payment_link),
  },
});
const privateStore = s => {
  const { pass_hash, ...rest } = s; return rest;
};

// ---------- Pix "copia e cola" (BR Code estático, dinheiro cai direto na conta do lojista) ----------
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function pixPayload({ key, name, city, amount, txid }) {
  const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const clean = (s, n) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, n) || 'LOJA';
  const body = f('00', '01') + f('01', '12') +
    f('26', f('00', 'BR.GOV.BCB.PIX') + f('01', key)) +
    f('52', '0000') + f('53', '986') + f('54', amount.toFixed(2)) + f('58', 'BR') +
    f('59', clean(name, 25)) + f('60', clean(city || 'BRASIL', 15)) +
    f('62', f('05', (txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) + '6304';
  return body + crc16(body);
}

// ---------- Tempo real (SSE) ----------
const streams = new Map();
function broadcast(storeId, event, data) {
  for (const res of streams.get(storeId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
setInterval(() => { for (const set of streams.values()) for (const r of set) r.write(': ping\n\n'); }, 25000).unref();

const STATUSES = ['novo', 'preparando', 'saiu', 'entregue', 'cancelado'];
const orderOut = o => ({ ...o, items: JSON.parse(o.items_json || '[]'), items_json: undefined });

// ---------- Rotas da API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  let g;

  // ----- público -----
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)$/)) && m === 'GET') {
    const s = db.prepare('SELECT * FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada');
    const categories = db.prepare('SELECT id,name FROM categories WHERE store_id=? ORDER BY position,id').all(s.id);
    const products = db.prepare('SELECT id,category_id,name,description,price,image_url FROM products WHERE store_id=? AND active=1 ORDER BY id').all(s.id);
    return json(res, 200, { store: publicStore(s), categories, products });
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/orders$/)) && m === 'POST') {
    if (limited(req, 'order', 15, 600e3)) return fail(res, 429, 'Muitos pedidos em pouco tempo. Tente de novo em alguns minutos.');
    const s = db.prepare('SELECT * FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada');
    if (!s.is_open) return fail(res, 400, 'A loja está fechada no momento.');
    const b = await readBody(req);
    const kind = b.kind === 'retirada' ? 'retirada' : 'entrega';
    const name = str(b.customer_name, 80), phone = str(b.phone, 30).replace(/[^\d+() -]/g, '');
    const address = str(b.address, 250);
    if (!name || phone.replace(/\D/g, '').length < 10) return fail(res, 400, 'Informe nome e telefone com DDD.');
    if (kind === 'entrega' && address.length < 6) return fail(res, 400, 'Informe o endereço de entrega.');
    const pm = publicStore(s).payments;
    const method = str(b.payment_method, 20);
    const allowed = { pix: pm.pix, dinheiro: pm.cash, cartao_entrega: pm.card_delivery, link: pm.link };
    if (!allowed[method]) return fail(res, 400, 'Forma de pagamento não disponível nesta loja.');
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 60) return fail(res, 400, 'Carrinho vazio.');
    let subtotal = 0; const items = [];
    const getP = db.prepare('SELECT id,name,price FROM products WHERE id=? AND store_id=? AND active=1');
    for (const it of b.items) {
      const prod = getP.get(Number(it.id), s.id);
      const qty = Math.floor(Number(it.qty));
      if (!prod || !(qty >= 1 && qty <= 50)) return fail(res, 400, 'Item inválido no carrinho.');
      subtotal += prod.price * qty;
      items.push({ name: prod.name, qty, price: prod.price, obs: str(it.obs, 120) });
    }
    if (subtotal < s.min_order) return fail(res, 400, `Pedido mínimo: R$ ${s.min_order.toFixed(2).replace('.', ',')}`);
    const fee = kind === 'entrega' ? s.delivery_fee : 0;
    const total = Math.round((subtotal + fee) * 100) / 100;
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const r = db.prepare(`INSERT INTO orders(store_id,code,customer_name,phone,kind,address,notes,payment_method,change_for,items_json,subtotal,delivery_fee,total)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, code, name, phone, kind, kind === 'entrega' ? address : '', str(b.notes, 250), method,
      method === 'dinheiro' ? str(b.change_for, 20) : '', JSON.stringify(items), subtotal, fee, total);
    const order = orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid));
    broadcast(s.id, 'order', order);
    const out = { code, total, status: 'novo' };
    if (method === 'pix') out.pix = pixPayload({ key: s.pix_key, name: s.pix_name || s.name, city: s.city, amount: total, txid: code });
    if (method === 'link') out.payment_link = s.payment_link;
    return json(res, 201, out);
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/orders\/([A-F0-9]{6})$/)) && m === 'GET') {
    const row = db.prepare(`SELECT o.status,o.total FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.slug=? AND o.code=?`).get(g[1], g[2]);
    return row ? json(res, 200, row) : fail(res, 404, 'Pedido não encontrado');
  }

  // ----- admin da plataforma -----
  if (p === '/api/admin/stores' && m === 'GET') {
    const pw = req.headers['x-admin-password'] || '';
    if (limited(req, 'admin', 20, 600e3)) return fail(res, 429, 'Muitas tentativas.');
    const a = Buffer.from(String(pw)), b = Buffer.from(ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 401, 'Senha incorreta');
    const rows = db.prepare('SELECT id,slug,name,email,whatsapp,created_at FROM stores ORDER BY id DESC').all()
      .map(s => { const r = monthRevenue(s.id); return { ...s, ...r, fee: monthlyFee(r.revenue) }; });
    return json(res, 200, { month: monthKey(), tiers: FEE_TIERS, total_fees: rows.reduce((a, s) => a + s.fee, 0), stores: rows });
  }

  // ----- conta do lojista -----
  if (p === '/api/signup' && m === 'POST') {
    if (limited(req, 'signup', 8, 3600e3)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
    const b = await readBody(req);
    const name = str(b.name, 60), email = str(b.email, 120).toLowerCase(), pw = String(b.password || '');
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return fail(res, 400, 'Informe nome da loja, e-mail válido e senha com 8+ caracteres.');
    if (db.prepare('SELECT 1 FROM stores WHERE email=?').get(email)) return fail(res, 409, 'Este e-mail já está cadastrado.');
    let base = slugify(b.slug || name) || 'loja', slug = base, i = 2;
    while (RESERVED.has(slug) || slug.length < 2 || db.prepare('SELECT 1 FROM stores WHERE slug=?').get(slug)) slug = `${base}-${i++}`.slice(0, 40);
    const r = db.prepare('INSERT INTO stores(slug,name,email,pass_hash,whatsapp) VALUES(?,?,?,?,?)').run(slug, name, email, hashPass(pw), str(b.whatsapp, 30));
    startSession(res, r.lastInsertRowid, req);
    return json(res, 201, { slug });
  }
  if (p === '/api/login' && m === 'POST') {
    if (limited(req, 'login', 10, 600e3)) return fail(res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const s = db.prepare('SELECT * FROM stores WHERE email=?').get(str(b.email, 120).toLowerCase());
    if (!s || !checkPass(String(b.password || ''), s.pass_hash)) return fail(res, 401, 'E-mail ou senha incorretos.');
    startSession(res, s.id, req);
    return json(res, 200, { slug: s.slug });
  }
  if (p === '/api/logout' && m === 'POST') {
    const t = cookies(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
  }

  const store = authStore(req);
  if (!p.startsWith('/api/')) return fail(res, 404, 'Não encontrado');
  if (!store) return fail(res, 401, 'Faça login.');

  if (p === '/api/me' && m === 'GET') return json(res, 200, privateStore(store));
  if (p === '/api/me' && m === 'PUT') {
    const b = await readBody(req);
    const f = {
      name: str(b.name, 60) || store.name, whatsapp: str(b.whatsapp, 30), address: str(b.address, 200), city: str(b.city, 60),
      pix_key: str(b.pix_key, 100), pix_name: str(b.pix_name, 60),
      accepts_pix: b.accepts_pix ? 1 : 0, accepts_cash: b.accepts_cash ? 1 : 0, accepts_card_delivery: b.accepts_card_delivery ? 1 : 0,
      accepts_link: b.accepts_link ? 1 : 0, payment_link: okUrl(str(b.payment_link, 500)),
      delivery_fee: Math.max(0, num(b.delivery_fee) || 0), min_order: Math.max(0, num(b.min_order) || 0), is_open: b.is_open ? 1 : 0,
    };
    if (f.accepts_pix && !f.pix_key) return fail(res, 400, 'Para aceitar Pix, informe sua chave Pix.');
    if (f.accepts_link && !f.payment_link) return fail(res, 400, 'Para aceitar link de pagamento, informe um link válido (https://...).');
    const cols = Object.keys(f);
    db.prepare(`UPDATE stores SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => f[c]), store.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/menu' && m === 'GET') {
    return json(res, 200, {
      categories: db.prepare('SELECT * FROM categories WHERE store_id=? ORDER BY position,id').all(store.id),
      products: db.prepare('SELECT * FROM products WHERE store_id=? ORDER BY id').all(store.id),
    });
  }
  if (p === '/api/categories' && m === 'POST') {
    const name = str((await readBody(req)).name, 50); if (!name) return fail(res, 400, 'Informe o nome.');
    const r = db.prepare('INSERT INTO categories(store_id,name) VALUES(?,?)').run(store.id, name);
    return json(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if ((g = p.match(/^\/api\/categories\/(\d+)$/)) && m === 'DELETE') {
    db.prepare('UPDATE products SET category_id=NULL WHERE category_id=? AND store_id=?').run(g[1], store.id);
    db.prepare('DELETE FROM categories WHERE id=? AND store_id=?').run(g[1], store.id);
    return json(res, 200, { ok: true });
  }
  if ((p === '/api/products' && m === 'POST') || ((g = p.match(/^\/api\/products\/(\d+)$/)) && (m === 'PUT' || m === 'DELETE'))) {
    if (m === 'DELETE') { db.prepare('DELETE FROM products WHERE id=? AND store_id=?').run(g[1], store.id); return json(res, 200, { ok: true }); }
    const b = await readBody(req);
    const name = str(b.name, 80), price = num(b.price);
    if (!name || !(price >= 0)) return fail(res, 400, 'Informe nome e preço válidos.');
    let cat = Number(b.category_id) || null;
    if (cat && !db.prepare('SELECT 1 FROM categories WHERE id=? AND store_id=?').get(cat, store.id)) cat = null;
    const vals = [cat, name, str(b.description, 300), Math.round(price * 100) / 100, okUrl(b.image_url), b.active === false || b.active === 0 ? 0 : 1];
    if (m === 'POST') {
      const r = db.prepare('INSERT INTO products(category_id,name,description,price,image_url,active,store_id) VALUES(?,?,?,?,?,?,?)').run(...vals, store.id);
      return json(res, 201, { id: Number(r.lastInsertRowid) });
    }
    db.prepare('UPDATE products SET category_id=?,name=?,description=?,price=?,image_url=?,active=? WHERE id=? AND store_id=?').run(...vals, g[1], store.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/orders' && m === 'GET') {
    const rows = db.prepare(`SELECT * FROM orders WHERE store_id=? AND created_at>=datetime('now','-2 days') ORDER BY id DESC LIMIT 300`).all(store.id);
    return json(res, 200, rows.map(orderOut));
  }
  if ((g = p.match(/^\/api\/orders\/(\d+)\/status$/)) && m === 'PUT') {
    const st = str((await readBody(req)).status, 20);
    if (!STATUSES.includes(st)) return fail(res, 400, 'Status inválido.');
    db.prepare('UPDATE orders SET status=? WHERE id=? AND store_id=?').run(st, g[1], store.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/billing' && m === 'GET') {
    const r = monthRevenue(store.id);
    const fee = monthlyFee(r.revenue);
    let next = null;
    if (r.revenue <= FEE_TIERS.freeUpTo) next = { at: FEE_TIERS.freeUpTo, fee: FEE_TIERS.midFee };
    else if (r.revenue <= FEE_TIERS.midUpTo) next = { at: FEE_TIERS.midUpTo, fee: FEE_TIERS.topFee };
    return json(res, 200, { month: monthKey(), ...r, fee, tiers: FEE_TIERS, next });
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (!streams.has(store.id)) streams.set(store.id, new Set());
    streams.get(store.id).add(res);
    req.on('close', () => streams.get(store.id)?.delete(res));
    return;
  }
  return fail(res, 404, 'Não encontrado');
}

// ---------- Recibo para impressora térmica (80mm) ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const PAY = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega', link: 'Link de pagamento' };
function receipt(store, o) {
  const items = JSON.parse(o.items_json || '[]');
  const when = new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Pedido ${esc(o.code)}</title>
<style>@
