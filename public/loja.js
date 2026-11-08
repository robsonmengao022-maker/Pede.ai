const slug = location.pathname.split('/')[1];
const brl = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const $ = id => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v; else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const put = (el, ...k) => el.replaceChildren(...k.flat().filter(c => c != null && c !== false));
const ls = { get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

let data, cart = {}; // id -> {qty, obs}

async function load() {
  const r = await fetch('/api/public/' + slug);
  if (!r.ok) { document.body.textContent = 'Loja não encontrada.'; return; }
  data = await r.json();
  document.title = data.store.name + ' — Cardápio';
  const s = data.store;
  put($('hd'), 
    h('h1', {}, s.name),
    h('p', {}, [s.address, s.city].filter(Boolean).join(' · ')),
    h('span', { class: 'badge ' + (s.is_open ? 'open' : 'closed') }, s.is_open ? 'Aberto agora' : 'Fechado no momento'),
    s.delivery_fee ? h('p', {}, 'Taxa de entrega: ' + brl(s.delivery_fee) + (s.min_order ? ' · Pedido mínimo: ' + brl(s.min_order) : '')) : null
  );
  renderMenu();
}

function renderMenu() {
  const groups = data.categories.map(c => ({ id: c.id, name: c.name, items: data.products.filter(p => p.category_id === c.id) }));
  const rest = data.products.filter(p => !data.categories.some(c => c.id === p.category_id));
  if (rest.length) groups.push({ id: 0, name: groups.length ? 'Outros' : 'Cardápio', items: rest });
  const gs = groups.filter(g => g.items.length);
  $('cats').replaceChildren(...gs.map(g => h('a', { href: '#c' + g.id }, g.name)));
  $('cats').hidden = gs.length < 2;
  $('menu').replaceChildren(...(gs.length ? gs.map(g => h('section', { id: 'c' + g.id }, h('h2', {}, g.name), g.items.map(card)))
    : [h('p', { class: 'foot' }, 'Esta loja ainda não cadastrou produtos.')]));
  updateBar();
}

function card(p) {
  const q = cart[p.id]?.qty || 0;
  return h('div', { class: 'item' },
    p.image_url ? h('img', { src: p.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
    h('div', { class: 't' }, h('b', {}, p.name), p.description ? h('small', {}, p.description) : null,
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
        h('span', { class: 'price' }, brl(p.price)),
        q ? h('span', { class: 'step' }, h('button', { onclick: () => chg(p.id, -1) }, '−'), q, h('button', { onclick: () => chg(p.id, 1) }, '+'))
          : h('button', { class: 'add', onclick: () => chg(p.id, 1) }, 'Adicionar'))));
}
function chg(id, d) {
  const q = (cart[id]?.qty || 0) + d;
  if (q <= 0) delete cart[id]; else cart[id] = { ...(cart[id] || { obs: '' }), qty: Math.min(q, 50) };
  renderMenu(); if ($('dlg').open && $('dlg').dataset.view === 'checkout') checkout();
}
const lines = () => Object.entries(cart).map(([id, c]) => ({ p: data.products.find(x => x.id == id), ...c })).filter(l => l.p);
const subtotal = () => lines().reduce((a, l) => a + l.p.price * l.qty, 0);
function updateBar() {
  const n = lines().reduce((a, l) => a + l.qty, 0);
  $('bar').hidden = !n;
  $('cartN').textContent = `Ver carrinho (${n})`; $('cartT').textContent = brl(subtotal());
}
$('cartBtn').onclick = checkout;

const PAYLABEL = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega (maquininha)', link: 'Cartão online (link de pagamento)' };
function checkout() {
  const s = data.store, d = $('dlg'); d.dataset.view = 'checkout';
  const pays = [['pix', s.payments.pix], ['dinheiro', s.payments.cash], ['cartao_entrega', s.payments.card_delivery], ['link', s.payments.link]].filter(x => x[1]).map(x => x[0]);
  const f = { kind: 'entrega', pay: pays[0] };
  const body = h('div', { class: 'pad' }, h('h3', {}, 'Seu pedido'),
    lines().map(l => h('div', { class: 'cartline' },
      h('div', {}, h('b', {}, l.qty + 'x ' + l.p.name), h('input', { placeholder: 'Observação (ex: sem cebola)', value: l.obs, maxlength: 120, style: 'margin-top:4px;padding:7px', oninput: e => cart[l.p.id].obs = e.target.value })),
      h('span', { class: 'step' }, h('button', { onclick: () => chg(l.p.id, -1) }, '−'), l.qty, h('button', { onclick: () => chg(l.p.id, 1) }, '+')))),
    h('div', { class: 'seg', style: 'margin-top:14px' },
      ['entrega', 'retirada'].map(k => h('label', {}, h('input', { type: 'radio', name: 'kind', value: k, checked: k === 'entrega', onchange: () => { f.kind = k; $('addrBox').hidden = k !== 'entrega'; totals(); } }), h('span', {}, k === 'entrega' ? 'Entrega' : 'Retirada')))),
    h('label', {}, 'Seu nome'), h('input', { id: 'f_name', autocomplete: 'name', value: ls.get('nm') }),
    h('label', {}, 'Telefone / WhatsApp (com DDD)'), h('input', { id: 'f_phone', type: 'tel', autocomplete: 'tel', value: ls.get('ph') }),
    h('div', { id: 'addrBox' }, h('label', {}, 'Endereço de entrega (rua, número, bairro)'), h('input', { id: 'f_addr', autocomplete: 'street-address', value: ls.get('ad') })),
    h('label', {}, 'Observações do pedido (opcional)'), h('textarea', { id: 'f_notes', rows: 2, maxlength: 250 }),
    h('label', {}, 'Forma de pagamento'),
    h('select', { id: 'f_pay', onchange: e => { f.pay = e.target.value; $('chBox').hidden = f.pay !== 'dinheiro'; } }, pays.map(k => h('option', { value: k }, PAYLABEL[k]))),
    h('div', { id: 'chBox', hidden: pays[0] !== 'dinheiro' }, h('label', {}, 'Troco para quanto? (opcional)'), h('input', { id: 'f_change', placeholder: 'Ex: 50' })),
    h('div', { style: 'margin-top:14px', id: 'tot' }),
    h('div', { class: 'err', id: 'err' }),
    h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
      h('button', { class: 'btn ghost', onclick: () => d.close() }, 'Voltar'),
      h('button', { class: 'btn', style: 'flex:1', id: 'send', onclick: () => send(f) }, 'Enviar pedido')));
  d.replaceChildren(body);
  function totals() {
    const fee = f.kind === 'entrega' ? s.delivery_fee : 0;
    put($('tot'), h('div', { class: 'row' }, h('span', {}, 'Subtotal'), h('span', {}, brl(subtotal()))),
      fee ? h('div', { class: 'row' }, h('span', {}, 'Entrega'), h('span', {}, brl(fee))) : null,
      h('div', { class: 'row tot' }, h('span', {}, 'Total'), h('span', {}, brl(subtotal() + fee))));
  }
  totals();
  if (!pays.length) { $('err').textContent = 'Esta loja ainda não configurou formas de pagamento.'; $('send').disabled = true; }
  if (!s.is_open) { $('err').textContent = 'A loja está fechada no momento.'; $('send').disabled = true; }
  if (!d.open) d.showModal();
  if (!lines().length) d.close();
}

async function send(f) {
  const btn = $('send'); btn.disabled = true; $('err').textContent = '';
  const body = {
    kind: f.kind, customer_name: $('f_name').value, phone: $('f_phone').value, address: $('f_addr').value, notes: $('f_notes').value,
    payment_method: $('f_pay').value, change_for: $('f_change').value,
    items: lines().map(l => ({ id: l.p.id, qty: l.qty, obs: l.obs })),
  };
  try {
    const r = await fetch(`/api/public/${slug}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { $('err').textContent = j.error || 'Erro ao enviar.'; btn.disabled = false; return; }
    ls.set('nm', body.customer_name); ls.set('ph', body.phone); ls.set('ad', body.address);
    cart = {}; renderMenu(); done(j, body.payment_method);
  } catch { $('err').textContent = 'Sem conexão. Tente novamente.'; btn.disabled = false; }
}

const STEPS = [['novo', 'Recebido'], ['preparando', 'Preparando'], ['saiu', 'Saiu / pronto'], ['entregue', 'Entregue']];
function done(j, method) {
  const d = $('dlg'); d.dataset.view = 'done';
  const st = h('div', { class: 'st' });
  const paint = s => st.replaceChildren(...(s === 'cancelado' ? [h('span', { class: 'on' }, 'Cancelado')] : STEPS.map(([k, n]) => h('span', { class: k === s ? 'on' : '' }, n))));
  paint(j.status);
  d.replaceChildren(h('div', { class: 'pad' },
    h('h3', {}, 'Pedido enviado! ✅'),
    h('p', {}, 'Código do pedido: ', h('b', {}, '#' + j.code), ' · Total ', h('b', {}, brl(j.total))),
    st,
    method === 'pix' ? h('div', {}, h('b', {}, 'Pague com Pix (copia e cola):'), h('div', { class: 'pix' }, j.pix),
      h('button', { class: 'btn', onclick: e => { navigator.clipboard?.writeText(j.pix); e.target.textContent = 'Copiado!'; } }, 'Copiar código Pix'),
      h('p', { style: 'color:var(--mute);font-size:13px' }, 'O pagamento vai direto para a conta da loja. Depois de pagar, é só aguardar.')) : null,
    method === 'link' ? h('div', {}, h('p', {}, 'Pague com cartão no link da loja. Informe o valor de ' + brl(j.total) + ' e o código #' + j.code + '.'),
      h('a', { class: 'btn', style: 'display:block;text-align:center;text-decoration:none', href: j.payment_link, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir link de pagamento')) : null,
    method === 'dinheiro' ? h('p', {}, 'Pagamento em dinheiro na ' + (data.store.address ? 'entrega/retirada.' : 'entrega.')) : null,
    method === 'cartao_entrega' ? h('p', {}, 'Pagamento com cartão na maquininha, na entrega/retirada.') : null,
    data.store.whatsapp ? h('a', { class: 'btn ghost', style: 'display:block;text-align:center;text-decoration:none;margin-top:10px', target: '_blank', rel: 'noopener noreferrer',
      href: 'https://wa.me/55' + data.store.whatsapp.replace(/\D/g, '').replace(/^55/, '') + '?text=' + encodeURIComponent('Olá! Fiz o pedido #' + j.code) }, 'Falar com a loja no WhatsApp') : null,
    h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => d.close() }, 'Fechar')));
  const t = setInterval(async () => {
    if (!d.open || d.dataset.view !== 'done') return clearInterval(t);
    try { const r = await fetch(`/api/public/${slug}/orders/${j.code}`); if (r.ok) paint((await r.json()).status); } catch {}
  }, 15000);
}
load();
