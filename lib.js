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
const PUBLIC = path.join(__dirname, 'public');
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
  lat REAL, lng REAL, km_fees TEXT DEFAULT '',
  prep_time TEXT DEFAULT '', hours TEXT DEFAULT '', store_notice TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS password_resets(store_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, store_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL, category_id INTEGER, name TEXT NOT NULL,
  description TEXT DEFAULT '', price REAL NOT NULL, image_url TEXT DEFAULT '', active INTEGER DEFAULT 1, groups_json TEXT DEFAULT '[]', position INTEGER DEFAULT 0);
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
function readBody(req, max = 200000) {
  return new Promise((ok, bad) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > max) { req.destroy(); bad(new Error('Corpo muito grande')); } });
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
const okUrl = u => { if (!u) return ''; if (/^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(u)) return u; try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ''; } catch { return ''; } };

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
// Grupos de escolha de um produto (adicionais e combos): [{name, min, max, items:[{name, price}]}]
function cleanGroups(raw) {
  if (!Array.isArray(raw)) return '[]';
  const out = raw.slice(0, 10).map(g => {
    const min = Math.max(0, Math.min(10, Math.floor(Number(g && g.min)) || 0));
    const max = Math.max(1, Math.min(20, Math.floor(Number(g && g.max)) || 1));
    const items = (Array.isArray(g && g.items) ? g.items : []).slice(0, 30)
      .map(it => ({ name: str(it && it.name, 60), price: Math.max(0, Math.round((Number(it && it.price) || 0) * 100) / 100) }))
      .filter(it => it.name);
    return { name: str(g && g.name, 40) || 'Opções', min: Math.min(min, max), max, items };
  }).filter(g => g.items.length);
  return JSON.stringify(out);
}
function parseGroups(raw) {
  try { const x = JSON.parse(raw || '[]'); return Array.isArray(x) ? x : []; } catch { return []; }
}

// Horário: lista de 7 dias (0 = domingo). Sem horário cadastrado, vale só o botão de abrir/fechar.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function cleanHours(raw) {
  if (!Array.isArray(raw) || raw.length !== 7) return '';
  return JSON.stringify(raw.map(d => ({ on: !!(d && d.on), open: HHMM.test(d && d.open) ? d.open : '08:00', close: HHMM.test(d && d.close) ? d.close : '22:00' })));
}
function isOpenNow(s) {
  if (!s.is_open) return false;
  let hours; try { hours = JSON.parse(s.hours || 'null'); } catch { hours = null; }
  if (!Array.isArray(hours)) return true;
  const br = new Date(Date.now() - 3 * 3600e3); // horário de Brasília
  const day = br.getUTCDay(), now = br.getUTCHours() * 60 + br.getUTCMinutes();
  const toM = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const hoje = hours[day];
  if (hoje && hoje.on) { const o = toM(hoje.open), c = toM(hoje.close); if (c > o ? (now >= o && now < c) : (now >= o)) return true; }
  const ontem = hours[(day + 6) % 7];
  if (ontem && ontem.on) { const o = toM(ontem.open), c = toM(ontem.close); if (c < o && now < c) return true; }
  return false;
}
const publicStore = s => ({
  slug: s.slug, name: s.name, whatsapp: s.whatsapp, address: s.address, numero: s.numero || '', bairro: s.bairro || '', city: s.city, uf: s.uf || '', is_open: isOpenNow(s),
  prep_time: s.prep_time || '', store_notice: s.store_notice || '', hours: s.hours || '',
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
db.exec(`CREATE TABLE IF NOT EXISTS coupons(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL, code TEXT NOT NULL,
  kind TEXT NOT NULL, value REAL NOT NULL, min_order REAL DEFAULT 0, max_uses INTEGER DEFAULT 0, used INTEGER DEFAULT 0,
  expires_at TEXT DEFAULT '', active INTEGER DEFAULT 1, UNIQUE(store_id, code));`);
for (const col of ['discount REAL DEFAULT 0', "coupon TEXT DEFAULT ''", "mp_payment_id TEXT DEFAULT ''", "mp_status TEXT DEFAULT ''", 'rating INTEGER DEFAULT 0', "rating_comment TEXT DEFAULT ''", "rated_at TEXT DEFAULT ''"]) { try { db.exec('ALTER TABLE orders ADD COLUMN ' + col); } catch {} }

// Valida o cupom e devolve o desconto; lança erro com mensagem para o cliente
function couponDiscount(storeId, rawCode, subtotal) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const c = db.prepare('SELECT * FROM coupons WHERE store_id=? AND code=?').get(storeId, code);
  if (!c || !c.active) throw new Error('Cupom inválido.');
  if (c.expires_at && new Date(c.expires_at + 'T23:59:59-03:00') < new Date()) throw new Error('Este cupom expirou.');
  if (c.max_uses && c.used >= c.max_uses) throw new Error('Este cupom já atingiu o limite de usos.');
  if (subtotal < c.min_order) throw new Error('Pedido mínimo para este cupom: R$ ' + c.min_order.toFixed(2).replace('.', ','));
  const raw = c.kind === 'percent' ? subtotal * c.value / 100 : c.value;
  return { id: c.id, code: c.code, discount: Math.round(Math.min(raw, subtotal) * 100) / 100 };
}

for (const col of ['uf TEXT DEFAULT \'\'', 'bairro TEXT DEFAULT \'\'', 'numero TEXT DEFAULT \'\'', 'cep TEXT DEFAULT \'\'']) { try { db.exec('ALTER TABLE stores ADD COLUMN ' + col); } catch {} }

const orderOut = o => ({ ...o, items: JSON.parse(o.items_json || '[]'), items_json: undefined });

module.exports = { cleanGroups, parseGroups, cleanHours, isOpenNow, PORT, DATA_DIR, ADMIN_PASSWORD, PUBLIC, db, FEE_TIERS, monthlyFee, monthKey, monthRevenue, MIME, send, json, fail, readBody, cookies, hashPass, checkPass, limited, slugify, RESERVED, str, num, okUrl, authStore, startSession, publicStore, privateStore, pixPayload, streams, broadcast, STATUSES, orderOut, couponDiscount };
