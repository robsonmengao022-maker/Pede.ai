'use strict';
// Pedeaí - servidor, rotas da API e páginas.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PORT, ADMIN_PASSWORD, PUBLIC, db, FEE_TIERS, monthlyFee, monthKey, monthRevenue, MIME, send, json, fail, readBody, cookies, hashPass, checkPass, limited, slugify, RESERVED, str, num, okUrl, authStore, startSession, publicStore, privateStore, pixPayload, streams, broadcast, STATUSES, orderOut } = require('./lib');
const { receipt } = require('./receipt');
const { geocode, kmFromPoints, parseFees, MAX_KM } = require('./geo');
const { sendMail, mailReady } = require('./mail');

const codeHash = code => crypto.createHash('sha256').update('pedeai-reset:' + code).digest('hex');

// Calcula a taxa de entrega da loja para um endereço (modo: tabela por km, em linha reta)
async function quoteDelivery(store, address) {
  const fees = parseFees(store.km_fees);
  if (!fees) return { error: 'Esta loja ainda não configurou a taxa de entrega. Use a opção de retirada ou fale com a loja.' };
  if (store.lat == null || store.lng == null) return { error: 'A loja ainda não tem o endereço localizado no mapa. Peça para o lojista salvar o endereço nas configurações.' };
  const city = store.city ? `, ${store.city}` : '';
  const point = await geocode(`${address}${city}, Brasil`);
  if (!point) return { error: 'Não encontrei esse endereço. Confira rua, número, bairro e cidade.' };
  const km = kmFromPoints({ lat: store.lat, lng: store.lng }, point);
  if (km > MAX_KM) return { error: `Endereço fora da área de entrega (até ${MAX_KM} km).` };
  const maxKm = fees.reduce((last, v, i) => (v !== null ? i + 1 : last), 0);
  if (km > maxKm) return { error: `Esta loja entrega até ${maxKm} km. Seu endereço fica a ${km} km.` };
  if (fees[km - 1] == null) return { error: `Esta loja não entrega a ${km} km. Confira o endereço ou fale com a loja.` };
  return { km, fee: fees[km - 1] };
}

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
    let fee = 0;
    if (kind === 'entrega') {
      const q = await quoteDelivery(s, address);
      if (q.error) return fail(res, 400, q.error);
      fee = q.fee;
    }
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
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/quote$/)) && m === 'GET') {
    const s = db.prepare('SELECT * FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada');
    if (limited(req, 'quote', 60, 600e3)) return fail(res, 429, 'Muitas consultas. Aguarde um pouco.');
    const address = str(url.searchParams.get('address'), 250);
    if (address.length < 6) return json(res, 200, { error: 'Digite o endereço completo.' });
    return json(res, 200, await quoteDelivery(s, address));
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
  if (p === '/api/forgot' && m === 'POST') {
    if (limited(req, 'forgot', 5, 3600e3)) return fail(res, 429, 'Muitas tentativas. Tente de novo daqui a uma hora.');
    if (!mailReady()) return fail(res, 503, 'Recuperação de senha indisponível no momento. Fale com a Pedeaí.');
    const b = await readBody(req);
    const email = str(b.email, 120).toLowerCase();
    const s = db.prepare('SELECT id, name FROM stores WHERE email=?').get(email);
    if (s) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      db.prepare('DELETE FROM password_resets WHERE store_id=?').run(s.id);
      db.prepare('INSERT INTO password_resets(store_id,code_hash,expires_at,attempts) VALUES(?,?,?,0)').run(s.id, codeHash(code), Date.now() + 15 * 60e3);
      const nome = String(s.name).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      try {
        await sendMail(email, 'Seu código para trocar a senha', `<p>Olá, ${nome}.</p><p>Seu código para trocar a senha é <b style="font-size:22px;letter-spacing:2px">${code}</b>. Ele vale por 15 minutos.</p><p>Se você não pediu isso, ignore este e-mail.</p>`);
      } catch (e) { console.error(e.message); }
    }
    // Resposta igual existindo ou não a conta, para ninguém descobrir e-mails cadastrados.
    return json(res, 200, { ok: true });
  }
  if (p === '/api/reset' && m === 'POST') {
    if (limited(req, 'reset', 20, 600e3)) return fail(res, 429, 'Muitas tentativas. Aguarde um pouco.');
    const b = await readBody(req);
    const email = str(b.email, 120).toLowerCase(), code = str(b.code, 6), pw = String(b.password || '');
    if (pw.length < 8) return fail(res, 400, 'A nova senha precisa ter 8 caracteres ou mais.');
    const s = db.prepare('SELECT id FROM stores WHERE email=?').get(email);
    const row = s ? db.prepare('SELECT * FROM password_resets WHERE store_id=?').get(s.id) : null;
    if (!row || row.expires_at < Date.now() || row.attempts >= 5) return fail(res, 400, 'Código inválido ou vencido. Peça um novo.');
    const a = Buffer.from(codeHash(code)), c = Buffer.from(row.code_hash);
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) {
      db.prepare('UPDATE password_resets SET attempts=attempts+1 WHERE store_id=?').run(s.id);
      return fail(res, 400, 'Código incorreto.');
    }
    db.prepare('UPDATE stores SET pass_hash=? WHERE id=?').run(hashPass(pw), s.id);
    db.prepare('DELETE FROM password_resets WHERE store_id=?').run(s.id);
    db.prepare('DELETE FROM sessions WHERE store_id=?').run(s.id);
    return json(res, 200, { ok: true });
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
    let warning = '';
    if ((f.address || f.city) && (f.address !== store.address || f.city !== store.city || store.lat == null)) {
      const pt = await geocode(`${f.address}, ${f.city}, Brasil`);
      f.lat = pt ? pt.lat : null;
      f.lng = pt ? pt.lng : null;
      if (!pt) warning = 'Não consegui localizar o endereço da loja no mapa. Confira rua, número e cidade e salve de novo.';
    }
    if (Array.isArray(b.km_fees)) {
      const clean = Array.from({ length: MAX_KM }, (_, i) => {
        const v = b.km_fees[i];
        if (v === '' || v == null) return null;
        const n = num(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
      });
      f.km_fees = JSON.stringify(clean);
    }
    if (f.accepts_pix && !f.pix_key) return fail(res, 400, 'Para aceitar Pix, informe sua chave Pix.');
    if (f.accepts_link && !f.payment_link) return fail(res, 400, 'Para aceitar link de pagamento, informe um link válido (https://...).');
    const cols = Object.keys(f);
    db.prepare(`UPDATE stores SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => f[c]), store.id);
    return json(res, 200, { ok: true, warning });
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

// ---------- Servidor ----------
const page = f => fs.readFileSync(path.join(PUBLIC, f));
const HTML = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return fail(res, 405, 'Método não permitido');
    if (p === '/') return send(res, 200, page('index.html'), HTML);
    if (p === '/painel') return send(res, 200, page('painel.html'), HTML);
    if (p === '/admin') return send(res, 200, page('admin.html'), HTML);
    if (/^\/(painel|painel2|loja)\.js$/.test(p)) return send(res, 200, page(p.slice(1)), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (p === '/health') return send(res, 200, 'ok');
    let g;
    if ((g = p.match(/^\/recibo\/(\d+)$/))) {
      const s = authStore(req); if (!s) return send(res, 401, 'Faça login', HTML);
      const o = db.prepare('SELECT * FROM orders WHERE id=? AND store_id=?').get(g[1], s.id);
      return o ? send(res, 200, receipt(s, o), HTML) : send(res, 404, 'Pedido não encontrado', HTML);
    }
    if ((g = p.match(/^\/([a-z0-9-]{2,40})\/?$/)) && !RESERVED.has(g[1]) && db.prepare('SELECT 1 FROM stores WHERE slug=?').get(g[1]))
      return send(res, 200, page('loja.html'), HTML);
    return send(res, 404, '<meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem"><h1>Página não encontrada</h1><a href="/">Voltar ao início</a>', HTML);
  } catch (e) {
    if (!res.headersSent) fail(res, e.message === 'JSON inválido' || e.message === 'Corpo muito grande' ? 400 : 500, e.message === 'JSON inválido' ? e.message : 'Erro interno');
    if (!['JSON inválido', 'Corpo muito grande'].includes(e.message)) console.error(e);
  }
});
setInterval(() => db.exec("DELETE FROM sessions WHERE created_at < datetime('now','-30 days')"), 6 * 3600e3).unref();
server.listen(PORT, () => console.log(`Pedeaí rodando em http://localhost:${PORT}`));
