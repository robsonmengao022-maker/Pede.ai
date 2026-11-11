'use strict';
// Pedeaí - servidor, rotas da API e páginas.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PORT, ADMIN_PASSWORD, PUBLIC, db, FEE_TIERS, monthlyFee, monthKey, monthRevenue, MIME, send, json, fail, readBody, cookies, hashPass, checkPass, limited, slugify, RESERVED, str, num, okUrl, authStore, startSession, publicStore, privateStore, pixPayload, streams, broadcast, STATUSES, orderOut , isOpenNow, cleanHours, cleanGroups, parseGroups } = require('./lib');
const { receipt } = require('./receipt');
const { geocode, geocodeEndereco, kmFromPoints, parseFees, MAX_KM } = require('./geo');
const { DATA_DIR, couponDiscount } = require('./lib');
// Pix só conta como pago depois de confirmado (Mercado Pago ou confirmação manual do lojista)
const pixPago = o => o.payment_method !== 'pix' || ['approved', 'manual'].includes(o.mp_status);
// Logo e capa só podem apontar para arquivos já enviados pelo painel
const upl = v => /^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(String(v || '')) ? String(v) : '';
const { oauthReady, cifra, decifra, urlAutorizacao, trocaCodigo, renovaToken, criarPix, buscarPagamento } = require('./mp');
// Token Mercado Pago da loja (descriptografado); renova sozinho quando está perto de vencer
async function tokenMP(s) {
  if (!s || !s.mp_access_token || !oauthReady()) return null;
  try {
    if (s.mp_expires_at - Date.now() > 5 * 60e3) return decifra(s.mp_access_token);
    const t = await renovaToken(decifra(s.mp_refresh_token));
    db.prepare('UPDATE stores SET mp_access_token=?, mp_refresh_token=?, mp_expires_at=? WHERE id=?')
      .run(cifra(t.access_token), cifra(t.refresh_token || decifra(s.mp_refresh_token)), t.expires_at, s.id);
    return t.access_token;
  } catch (e) { console.error('Mercado Pago (token da loja):', e.message); return null; }
}
const { sendMail, mailReady } = require('./mail');
const { enviaBackup } = require('./backup');

const codeHash = code => crypto.createHash('sha256').update('pedeai-reset:' + code).digest('hex');

// Calcula a taxa de entrega da loja para um endereço (modo: tabela por km, em linha reta)
// Endereço completo para localizar no mapa: rua, número, bairro, cidade - UF
const enderecoCompleto = x => [x.address, x.numero, x.bairro, [x.city, x.uf].filter(Boolean).join(' - '), 'Brasil'].filter(Boolean).join(', ');

async function quoteDelivery(store, address) {
  const fees = parseFees(store.km_fees);
  if (!fees) return { error: 'Esta loja ainda não configurou a taxa de entrega. Use a opção de retirada ou fale com a loja.' };
  if (store.lat == null || store.lng == null) return { error: 'A loja ainda não tem o endereço localizado no mapa. Peça para o lojista salvar o endereço nas configurações.' };
  const area = [store.city, store.uf].filter(Boolean).join(' - ');
  const point = await geocodeEndereco(address, area);
  // Endereço não localizado no mapa: o pedido segue com a taxa "a calcular", e a loja confirma
  if (!point) return { km: null, fee: 0, aCalcular: true, aviso: 'Não localizamos esse endereço no mapa. A taxa de entrega será confirmada pela loja.' };
  const km = kmFromPoints({ lat: store.lat, lng: store.lng }, point);
  if (km > MAX_KM) return { error: `Endereço fora da área de entrega (até ${MAX_KM} km).` };
  const maxKm = fees.reduce((last, v, i) => (v !== null ? i + 1 : last), 0);
  if (km > maxKm) return { error: `Esta loja entrega até ${maxKm} km. Seu endereço fica a ${km} km.` };
  if (fees[km - 1] == null) return { error: `Esta loja não entrega a ${km} km. Confira o endereço ou fale com a loja.` };
  return { km, fee: fees[km - 1] };
}

const brlTxt = v => 'R$ ' + v.toFixed(2).replace('.', ',');

// ---------- Rotas da API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  let g;

  // ----- público -----
  // ----- entregador e acompanhamento (links secretos) -----
  if ((g = p.match(/^\/api\/driver\/([a-f0-9]{24})$/)) && m === 'GET') {
    const mb = db.prepare('SELECT m.id,m.name,s.name AS store FROM motoboys m JOIN stores s ON s.id=m.store_id WHERE m.token=?').get(g[1]);
    if (!mb) return fail(res, 404, 'Link inválido');
    const pedidos = db.prepare("SELECT code,customer_name,phone,address,notes,items_json,total,payment_method,change_for FROM orders WHERE driver_id=? AND status='saiu' ORDER BY id")
      .all(mb.id).map(o => ({ ...o, items: JSON.parse(o.items_json || '[]'), items_json: undefined }));
    return json(res, 200, { name: mb.name, store: mb.store, pedidos });
  }
  if ((g = p.match(/^\/api\/driver\/([a-f0-9]{24})\/pos$/)) && m === 'POST') {
    const b = await readBody(req);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail(res, 400, 'Posição inválida');
    const r = db.prepare("UPDATE motoboys SET lat=?, lng=?, pos_at=datetime('now') WHERE token=?").run(lat, lng, g[1]);
    if (!r.changes) return fail(res, 404, 'Link inválido');
    return json(res, 200, { ok: true });
  }
  if ((g = p.match(/^\/api\/track\/([a-f0-9]{24})$/)) && m === 'GET') {
    const o = db.prepare('SELECT o.code,o.status,o.kind,o.driver_id,s.name AS store FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.track_token=?').get(g[1]);
    if (!o) return fail(res, 404, 'Pedido não encontrado');
    const mb = o.driver_id ? db.prepare('SELECT name,lat,lng,pos_at FROM motoboys WHERE id=?').get(o.driver_id) : null;
    return json(res, 200, { code: o.code, status: o.status, kind: o.kind, store: o.store,
      driver: mb && o.status === 'saiu' ? { name: mb.name, lat: mb.lat, lng: mb.lng, pos_at: mb.pos_at } : null });
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)$/)) && m === 'GET') {
    const s = db.prepare('SELECT * FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada');
    const categories = db.prepare('SELECT id,name FROM categories WHERE store_id=? ORDER BY position,id').all(s.id);
    const products = db.prepare('SELECT id,category_id,name,description,price,image_url,groups_json FROM products WHERE store_id=? AND active=1 ORDER BY position,id').all(s.id);
    return json(res, 200, { store: publicStore(s), categories, products });
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/orders$/)) && m === 'POST') {
    if (limited(req, 'order', 15, 600e3)) return fail(res, 429, 'Muitos pedidos em pouco tempo. Tente de novo em alguns minutos.');
    const s = db.prepare('SELECT * FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada');
    if (!isOpenNow(s)) return fail(res, 400, 'A loja está fechada no momento.');
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
    const getP = db.prepare('SELECT id,name,price,groups_json FROM products WHERE id=? AND store_id=? AND active=1');
    for (const it of b.items) {
      const prod = getP.get(Number(it.id), s.id);
      const qty = Math.floor(Number(it.qty));
      if (!prod || !(qty >= 1 && qty <= 50)) return fail(res, 400, 'Item inválido no carrinho.');
      let extra = 0; const txt = [];
      for (const g of parseGroups(prod.groups_json)) {
        const mine = (Array.isArray(it.choices) ? it.choices : []).find(x => x && x.group === g.name);
        const lista = mine && Array.isArray(mine.picks) ? mine.picks.map(v => str(v, 60)) : [];
        if (lista.length < g.min || lista.length > g.max) return fail(res, 400, `Em "${g.name}", escolha de ${g.min} a ${g.max} opção(ões).`);
        if (g.max === 1 && lista.length > 1) return fail(res, 400, `Em "${g.name}", escolha só uma opção.`);
        const cont = new Map(); for (const nm of lista) cont.set(nm, (cont.get(nm) || 0) + 1);
        const chosen = [...cont].map(([nm, n]) => {
          const opt = g.items.find(x => x.name === nm);
          if (!opt) return null;
          extra += opt.price * n;
          return opt.name + (n > 1 ? ` x${n}` : '') + (opt.price ? ` (+ ${brlTxt(opt.price * n)})` : '');
        });
        if (chosen.includes(null)) return fail(res, 400, 'Opção inválida no carrinho.');
        if (chosen.length) txt.push(`${g.name}: ${chosen.join(', ')}`);
      }
      const unit = Math.round((prod.price + extra) * 100) / 100;
      subtotal += unit * qty;
      items.push({ name: prod.name, qty, price: unit, obs: str(it.obs, 120), choices: txt.join(' · ') });
    }
    if (subtotal < s.min_order) return fail(res, 400, `Pedido mínimo: R$ ${s.min_order.toFixed(2).replace('.', ',')}`);
    let fee = 0, taxaACalcular = false;
    if (kind === 'entrega') {
      const q = await quoteDelivery(s, address);
      if (q.error) return fail(res, 400, q.error);
      fee = q.fee;
      taxaACalcular = !!q.aCalcular;
    }
    let discount = 0, couponCode = '', couponId = null;
    if (str(b.coupon, 30)) {
      try { const cd = couponDiscount(s.id, b.coupon, subtotal); if (cd) { discount = cd.discount; couponCode = cd.code; couponId = cd.id; } }
      catch (e) { return fail(res, 400, e.message); }
    }
    const total = Math.round((subtotal - discount + fee) * 100) / 100;
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const r = db.prepare(`INSERT INTO orders(store_id,code,customer_name,phone,kind,address,notes,payment_method,change_for,items_json,subtotal,delivery_fee,total,discount,coupon)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, code, name, phone, kind, kind === 'entrega' ? address : '', (taxaACalcular ? '[TAXA A CONFIRMAR: endereço não localizado no mapa] ' : '') + str(b.notes, 250), method,
      method === 'dinheiro' ? str(b.change_for, 20) : '', JSON.stringify(items), subtotal, fee, total, discount, couponCode);
    if (couponId) db.prepare('UPDATE coupons SET used=used+1 WHERE id=?').run(couponId);
    // Dinheiro e maquininha: já nascem aceitos (comanda sai na impressão). Pix aceita quando o pagamento for aprovado.
    if (method === 'dinheiro' || method === 'cartao_entrega') db.prepare("UPDATE orders SET status='preparando' WHERE id=?").run(r.lastInsertRowid);
    const order = orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid));
    broadcast(s.id, 'order', order);
    let mpPix = '';
    const tkMP = method === 'pix' ? await tokenMP(s) : null;
    if (method === 'pix' && !tkMP && !s.pix_key) return fail(res, 400, 'Esta loja ainda não configurou o Pix. Escolha outra forma de pagamento.');
    if (tkMP) {
      try {
        const pay = await criarPix({ token: tkMP, amount: total, description: `Pedido ${code} - ${s.name}`, email: `pedido${code.toLowerCase()}@pedeai.app`, idem: `${code}-${r.lastInsertRowid}` });
        db.prepare('UPDATE orders SET mp_payment_id=?, mp_status=? WHERE id=?').run(pay.id, pay.status, r.lastInsertRowid);
        mpPix = pay.qr;
      } catch (e) { console.error('Mercado Pago (Pix):', e.message); }
    }
    const out = { code, total, status: 'novo' };
    if (method === 'pix') out.pix = mpPix || pixPayload({ key: s.pix_key, name: s.pix_name || s.name, city: s.city, amount: total, txid: code });
    if (method === 'link') out.payment_link = s.payment_link;
    return json(res, 201, out);
  }
  if (p === '/api/mp/callback' && m === 'GET') {
    // volta do Mercado Pago depois que o lojista autoriza a conta
    const volta = q => { res.writeHead(302, { Location: '/painel?mp=' + q }); res.end(); };
    const code = url.searchParams.get('code') || '', st = url.searchParams.get('state') || '';
    const row = st ? db.prepare("SELECT store_id FROM mp_states WHERE state=? AND created_at > datetime('now','-1 hour')").get(st) : null;
    db.prepare('DELETE FROM mp_states WHERE state=?').run(st);
    if (url.searchParams.get('error') || !code || !row || !oauthReady()) return volta('erro');
    try {
      const t = await trocaCodigo(code);
      db.prepare('UPDATE stores SET mp_user_id=?, mp_access_token=?, mp_refresh_token=?, mp_expires_at=? WHERE id=?')
        .run(t.user_id, cifra(t.access_token), cifra(t.refresh_token), t.expires_at, row.store_id);
      return volta('ok');
    } catch (e) { console.error('Mercado Pago (conectar):', e.message); return volta('erro'); }
  }
  if (p === '/api/mercadopago/webhook' && m === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const id = (b.data && b.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id');
    const ped = id ? db.prepare('SELECT store_id FROM orders WHERE mp_payment_id=?').get(String(id)) : null;
    const dono = ped ? db.prepare('SELECT * FROM stores WHERE id=?').get(ped.store_id) : null;
    const tk = dono ? await tokenMP(dono) : null;
    if (tk) {
      try {
        const pay = await buscarPagamento(tk, id);
        db.prepare('UPDATE orders SET mp_status=? WHERE mp_payment_id=?').run(pay.status, pay.id);
        // Pix pago: aceita o pedido automaticamente (a comanda sai na impressora)
        if (pay.status === 'approved') db.prepare("UPDATE orders SET status='preparando' WHERE mp_payment_id=? AND status='novo'").run(pay.id);
        const o = db.prepare('SELECT * FROM orders WHERE mp_payment_id=?').get(pay.id);
        if (o) broadcast(o.store_id, 'order', orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
      } catch (e) { console.error('Mercado Pago (webhook):', e.message); }
    }
    return json(res, 200, { ok: true });
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/coupon$/)) && m === 'GET') {
    const s = db.prepare('SELECT id FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada.');
    try { return json(res, 200, couponDiscount(s.id, url.searchParams.get('code'), num(url.searchParams.get('subtotal')) || 0)); }
    catch (e) { return fail(res, 400, e.message); }
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
    const row = db.prepare(`SELECT o.status,o.total,o.mp_status,o.rating,o.items_json FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.slug=? AND o.code=?`).get(g[1], g[2]);
    if (!row) return fail(res, 404, 'Pedido não encontrado');
    const itens = JSON.parse(row.items_json || '[]').map(i => i.qty + 'x ' + i.name);
    return json(res, 200, { status: row.status, total: row.total, paid: row.mp_status === 'approved', rating: row.rating || 0, itens });
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/orders\/([A-F0-9]{6})\/avaliar$/)) && m === 'POST') {
    if (limited(req, 'avaliar', 10, 600e3)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
    const b = await readBody(req);
    const nota = Math.floor(Number(b.rating));
    if (!(nota >= 1 && nota <= 5)) return fail(res, 400, 'Escolha de 1 a 5 estrelas.');
    const row = db.prepare(`SELECT o.id,o.status,o.phone,o.rating FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.slug=? AND o.code=?`).get(g[1], g[2]);
    if (!row) return fail(res, 404, 'Pedido não encontrado');
    const fone = str(b.phone, 30).replace(/\D/g, '');
    if (fone.length < 8 || fone.slice(-8) !== String(row.phone || '').replace(/\D/g, '').slice(-8)) return fail(res, 403, 'Confirme o telefone usado no pedido.');
    if (row.status !== 'entregue') return fail(res, 400, 'Você poderá avaliar depois que o pedido for entregue.');
    if (row.rating) return fail(res, 400, 'Este pedido já foi avaliado.');
    db.prepare(`UPDATE orders SET rating=?, rating_comment=?, rated_at=datetime('now') WHERE id=?`).run(nota, str(b.comment, 500), row.id);
    return json(res, 200, { ok: true });
  }
  if ((g = p.match(/^\/api\/public\/([a-z0-9-]+)\/avaliacoes$/)) && m === 'GET') {
    const s = db.prepare('SELECT id FROM stores WHERE slug=?').get(g[1]);
    if (!s) return fail(res, 404, 'Loja não encontrada');
    const media = db.prepare('SELECT AVG(rating) a, COUNT(*) n FROM orders WHERE store_id=? AND rating>0').get(s.id);
    const lista = db.prepare('SELECT rating, rating_comment, rated_at FROM orders WHERE store_id=? AND rating>0 ORDER BY id DESC LIMIT 30').all(s.id);
    return json(res, 200, { media: media.a ? Math.round(media.a * 10) / 10 : 0, total: media.n, lista });
  }

  // ----- backup (admin da plataforma) -----
  if ((p === '/api/admin/backup' || p === '/api/admin/restore') && m === 'POST') {
    if (limited(req, 'backup', 10, 600e3)) return fail(res, 429, 'Muitas tentativas.');
    const a = Buffer.from(String(req.headers['x-admin-password'] || '')), b = Buffer.from(ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 401, 'Senha incorreta');
    if (p === '/api/admin/backup') {
      try { const r = await enviaBackup({ db, sendMail, dataDir: DATA_DIR }); return json(res, 200, { ok: true, ...r }); }
      catch (e) { return fail(res, 400, e.message); }
    }
    const body = await readBody(req, 40e6);
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (buf.length < 100 || buf.subarray(0, 15).toString() !== 'SQLite format 3') return fail(res, 400, 'Arquivo inválido. Envie um backup .db do Pedeaí.');
    fs.writeFileSync(path.join(DATA_DIR, 'restore.db'), buf);
    return json(res, 200, { ok: true, msg: 'Backup recebido. Reinicie o serviço no Render (Manual Deploy > Restart) para restaurar.' });
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

  if (p === '/api/upload' && m === 'POST') {
    if (limited(req, 'upload', 60, 3600e3)) return fail(res, 429, 'Muitos envios. Aguarde um pouco.');
    const b = await readBody(req, 1500000);
    const mm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    if (!mm) return fail(res, 400, 'Escolha uma imagem (JPG, PNG ou WebP).');
    const buf = Buffer.from(mm[2], 'base64');
    if (buf.length > 1000000) return fail(res, 400, 'Foto muito grande. Tente outra.');
    fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
    const name = crypto.randomBytes(12).toString('hex') + '.' + (mm[1] === 'jpeg' ? 'jpg' : mm[1]);
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
    return json(res, 201, { url: '/uploads/' + name });
  }
  if (p === '/api/mp/conectar' && m === 'GET') {
    if (!oauthReady()) return fail(res, 503, 'A conexão com o Mercado Pago ainda não está configurada no servidor.');
    const state = crypto.randomBytes(16).toString('hex');
    db.prepare("DELETE FROM mp_states WHERE created_at < datetime('now','-1 hour')").run();
    db.prepare('INSERT INTO mp_states(state,store_id) VALUES(?,?)').run(state, store.id);
    return json(res, 200, { url: urlAutorizacao(state) });
  }
  if (p === '/api/mp/desconectar' && m === 'POST') {
    db.prepare("UPDATE stores SET mp_user_id='', mp_access_token='', mp_refresh_token='', mp_expires_at=0 WHERE id=?").run(store.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'GET') return json(res, 200, privateStore(store));
  if (p === '/api/me' && m === 'PUT') {
    const b = await readBody(req);
    const f = {
      name: str(b.name, 60) || store.name, whatsapp: str(b.whatsapp, 30), address: str(b.address, 200), city: str(b.city, 60),
      uf: str(b.uf, 2).toUpperCase(), bairro: str(b.bairro, 60), numero: str(b.numero, 10), cep: str(b.cep, 9),
      pix_key: str(b.pix_key, 100), pix_name: str(b.pix_name, 60),
      accepts_pix: b.accepts_pix ? 1 : 0, accepts_cash: b.accepts_cash ? 1 : 0, accepts_card_delivery: b.accepts_card_delivery ? 1 : 0,
      accepts_link: b.accepts_link ? 1 : 0, payment_link: okUrl(str(b.payment_link, 500)),
      delivery_fee: Math.max(0, num(b.delivery_fee) || 0), min_order: Math.max(0, num(b.min_order) || 0), is_open: b.is_open ? 1 : 0,
      logo_url: upl(b.logo_url), capa_url: upl(b.capa_url), print_media: b.print_media ? 1 : 0,
    };
    let warning = '';
    if ((f.address || f.city) && (f.address !== store.address || f.city !== store.city || store.lat == null)) {
      const pt = await geocodeEndereco([f.address, f.numero].filter(Boolean).join(', ') + (f.bairro ? ' - ' + f.bairro : ''), [f.city, f.uf].filter(Boolean).join(' - '));
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
    f.prep_time = str(b.prep_time, 30); f.store_notice = str(b.store_notice, 200);
    if (b.hours !== undefined) f.hours = cleanHours(b.hours);
    if (f.accepts_pix && !f.pix_key && !store.mp_access_token) return fail(res, 400, 'Para aceitar Pix, informe sua chave Pix ou conecte sua conta do Mercado Pago.');
    if (f.accepts_link && !f.payment_link) return fail(res, 400, 'Para aceitar link de pagamento, informe um link válido (https://...).');
    const cols = Object.keys(f);
    db.prepare(`UPDATE stores SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => f[c]), store.id);
    return json(res, 200, { ok: true, warning });
  }
  if (p === '/api/menu' && m === 'GET') {
    return json(res, 200, {
      categories: db.prepare('SELECT * FROM categories WHERE store_id=? ORDER BY position,id').all(store.id),
      products: db.prepare('SELECT * FROM products WHERE store_id=? ORDER BY position,id').all(store.id),
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
    const vals = [cat, name, str(b.description, 300), Math.round(price * 100) / 100, okUrl(b.image_url), b.active === false || b.active === 0 ? 0 : 1, cleanGroups(b.groups)];
    if (m === 'POST') {
      const r = db.prepare('INSERT INTO products(category_id,name,description,price,image_url,active,groups_json,store_id,position) VALUES(?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM products WHERE store_id=?))').run(...vals, store.id, store.id);
      return json(res, 201, { id: Number(r.lastInsertRowid) });
    }
    db.prepare('UPDATE products SET category_id=?,name=?,description=?,price=?,image_url=?,active=?,groups_json=? WHERE id=? AND store_id=?').run(...vals, g[1], store.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/reorder' && m === 'POST') {
    const b = await readBody(req);
    const table = b.type === 'categories' ? 'categories' : b.type === 'products' ? 'products' : null;
    if (!table || !Array.isArray(b.ids)) return fail(res, 400, 'Pedido de ordem inválido.');
    const up = db.prepare(`UPDATE ${table} SET position=? WHERE id=? AND store_id=?`);
    b.ids.slice(0, 500).forEach((id, i) => up.run(i + 1, Number(id), store.id));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/orders' && m === 'GET') {
    const rows = db.prepare(`SELECT * FROM orders WHERE store_id=? AND created_at>=datetime('now','-2 days') ORDER BY id DESC LIMIT 300`).all(store.id);
    return json(res, 200, rows.map(orderOut));
  }
  if ((g = p.match(/^\/api\/orders\/(\d+)\/pix-confirmar$/)) && m === 'POST') {
    const o = db.prepare('SELECT * FROM orders WHERE id=? AND store_id=?').get(g[1], store.id);
    if (!o) return fail(res, 404, 'Pedido não encontrado');
    if (o.payment_method !== 'pix') return fail(res, 400, 'Este pedido não é Pix.');
    if (!pixPago(o)) db.prepare("UPDATE orders SET mp_status='manual' WHERE id=?").run(o.id);
    const atual = orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
    broadcast(store.id, 'order', atual);
    return json(res, 200, atual);
  }
  if ((g = p.match(/^\/api\/orders\/(\d+)\/status$/)) && m === 'PUT') {
    const st = str((await readBody(req)).status, 20);
    if (!STATUSES.includes(st)) return fail(res, 400, 'Status inválido.');
    const ord = db.prepare('SELECT payment_method,mp_status FROM orders WHERE id=? AND store_id=?').get(g[1], store.id);
    if (!ord) return fail(res, 404, 'Pedido não encontrado');
    if (st !== 'cancelado' && !pixPago(ord)) return fail(res, 400, 'Pix ainda não confirmado. Aceite o pedido só depois que o pagamento cair.');
    db.prepare('UPDATE orders SET status=? WHERE id=? AND store_id=?').run(st, g[1], store.id);
    return json(res, 200, { ok: true });
  }
  // ----- entregadores (painel da loja) -----
  if (p === '/api/motoboys' && m === 'GET') {
    const lista = db.prepare('SELECT id,name,phone,token,lat,lng,pos_at FROM motoboys WHERE store_id=? ORDER BY id').all(store.id);
    const ativos = db.prepare("SELECT code,customer_name,address,driver_id FROM orders WHERE store_id=? AND status='saiu' AND driver_id>0").all(store.id);
    return json(res, 200, lista.map(x => ({ ...x, pedidos: ativos.filter(o => o.driver_id === x.id) })));
  }
  if (p === '/api/motoboys' && m === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 60), phone = str(b.phone, 30).replace(/[^\d+() -]/g, '');
    if (!name) return fail(res, 400, 'Informe o nome do motoboy.');
    if (db.prepare('SELECT COUNT(*) n FROM motoboys WHERE store_id=?').get(store.id).n >= 30) return fail(res, 400, 'Limite de 30 motoboys por loja.');
    const token = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO motoboys(store_id,name,phone,token) VALUES(?,?,?,?)').run(store.id, name, phone, token);
    return json(res, 201, { ok: true, token });
  }
  if ((g = p.match(/^\/api\/motoboys\/(\d+)$/)) && m === 'DELETE') {
    db.prepare('DELETE FROM motoboys WHERE id=? AND store_id=?').run(g[1], store.id);
    db.prepare("UPDATE orders SET driver_id=0 WHERE driver_id=? AND store_id=? AND status!='entregue'").run(g[1], store.id);
    return json(res, 200, { ok: true });
  }
  if ((g = p.match(/^\/api\/orders\/(\d+)\/entregador$/)) && m === 'PUT') {
    const b = await readBody(req);
    const id = Number(b.driver_id) || 0;
    if (id && !db.prepare('SELECT 1 FROM motoboys WHERE id=? AND store_id=?').get(id, store.id)) return fail(res, 400, 'Motoboy não encontrado.');
    const ord = db.prepare('SELECT id,track_token FROM orders WHERE id=? AND store_id=?').get(g[1], store.id);
    if (!ord) return fail(res, 404, 'Pedido não encontrado');
    const track = ord.track_token || crypto.randomBytes(12).toString('hex');
    db.prepare('UPDATE orders SET driver_id=?, track_token=? WHERE id=?').run(id, track, ord.id);
    return json(res, 200, { ok: true, track });
  }
  if (p === '/api/coupons' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM coupons WHERE store_id=? ORDER BY id DESC').all(store.id));
  if (p === '/api/coupons' && m === 'POST') {
    const b = await readBody(req);
    const code = str(b.code, 30).trim().toUpperCase().replace(/\s+/g, '');
    const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
    const value = num(b.value), min = Math.max(0, num(b.min_order) || 0), max = Math.max(0, Math.floor(num(b.max_uses) || 0));
    const exp = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_at || '')) ? b.expires_at : '';
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return fail(res, 400, 'Código: use de 3 a 30 letras ou números, sem espaço.');
    if (!(value > 0) || (kind === 'percent' && value > 100)) return fail(res, 400, kind === 'percent' ? 'Informe um percentual entre 1 e 100.' : 'Informe o valor do desconto.');
    if (db.prepare('SELECT 1 FROM coupons WHERE store_id=? AND code=?').get(store.id, code)) return fail(res, 409, 'Já existe um cupom com este código.');
    const r = db.prepare('INSERT INTO coupons(store_id,code,kind,value,min_order,max_uses,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(store.id, code, kind, Math.round(value * 100) / 100, min, max, exp);
    return json(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if ((g = p.match(/^\/api\/coupons\/(\d+)$/)) && m === 'DELETE') {
    db.prepare('DELETE FROM coupons WHERE id=? AND store_id=?').run(g[1], store.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/billing' && m === 'GET') {
    const r = monthRevenue(store.id);
    const fee = monthlyFee(r.revenue);
    let next = null;
    if (r.revenue < FEE_TIERS.minRevenue) next = { at: FEE_TIERS.minRevenue, fee: FEE_TIERS.fee };
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
    if (p.startsWith('/uploads/')) {
      const f = path.basename(p), fp = path.join(DATA_DIR, 'uploads', f);
      if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(f) || !fs.existsSync(fp)) return send(res, 404, 'Não encontrado', HTML);
      const type = f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return send(res, 200, fs.readFileSync(fp), { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    }
    if (p === '/') return send(res, 200, page('index.html'), HTML);
    if (p === '/painel') return send(res, 200, page('painel.html'), HTML);
    if (p === '/admin') return send(res, 200, page('admin.html'), HTML);
    if (/^\/(painel|painel2|loja)\.js$/.test(p)) return send(res, 200, page(p.slice(1)), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (/^\/(entregador|acompanhar)\/[a-f0-9]{24}$/.test(p)) return send(res, 200, page(p.split('/')[1] + '.html'), HTML);
    if (p === '/health') return send(res, 200, 'ok');
    let g;
    if ((g = p.match(/^\/recibo\/(\d+)$/))) {
      const s = authStore(req); if (!s) return send(res, 401, 'Faça login', HTML);
      const o = db.prepare('SELECT * FROM orders WHERE id=? AND store_id=?').get(g[1], s.id);
      if (o && !pixPago(o)) return send(res, 403, 'Pix ainda não confirmado. A comanda só sai depois do pagamento.', HTML);
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

// Rede de segurança: consulta no Mercado Pago os Pix ainda não aprovados, caso o aviso (webhook) se perca
async function conferePixPendentes() {
  const pend = db.prepare(`SELECT id,store_id,mp_payment_id,mp_status FROM orders
    WHERE payment_method='pix' AND mp_payment_id IS NOT NULL AND created_at >= datetime('now','-2 hours')
    AND (mp_status IS NULL OR mp_status NOT IN ('approved','manual','cancelled','rejected','refunded'))
    ORDER BY id LIMIT 30`).all();
  for (const o of pend) {
    try {
      const dono = db.prepare('SELECT * FROM stores WHERE id=?').get(o.store_id);
      const tk = dono ? await tokenMP(dono) : null;
      if (!tk) continue;
      const pay = await buscarPagamento(tk, o.mp_payment_id);
      if (pay.status && pay.status !== o.mp_status) {
        db.prepare('UPDATE orders SET mp_status=? WHERE id=?').run(pay.status, o.id);
        // Pix pago: aceita o pedido automaticamente (a comanda sai na impressora)
        if (pay.status === 'approved') db.prepare("UPDATE orders SET status='preparando' WHERE id=? AND status='novo'").run(o.id);
        broadcast(o.store_id, 'order', orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
      }
    } catch (e) { console.error('Mercado Pago (conferência):', e.message); }
  }
}
setInterval(() => conferePixPendentes().catch(() => {}), Number(process.env.PIX_CONFERE_MS) || 5e3).unref();
require('./fechamento').agendaFechamento({ db, sendMail });
require('./backup').agendaBackup({ db, sendMail, dataDir: DATA_DIR });

server.listen(PORT, () => console.log(`Pedeaí rodando em http://localhost:${PORT}`));

// Mantém o site acordado no plano gratuito do Render: acessa o próprio endereço a cada 5 minutos.
// Desligue com KEEP_ALIVE=off.
if (process.env.KEEP_ALIVE !== 'off') {
  const alvo = (process.env.PUBLIC_URL || 'https://pedeaiapp.online').replace(/\/$/, '') + '/';
  setInterval(() => fetch(alvo, { signal: AbortSignal.timeout(20000) }).catch(() => {}), 5 * 60e3).unref();
}
