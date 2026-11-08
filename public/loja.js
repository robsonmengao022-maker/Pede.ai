const slug = location.pathname.split('/')[1];
const brl = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const $ = id => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'checked' || k === 'value' || k === 'disabled' || k === 'selected') e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const ls = { get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const parseG = raw => { try { const x = JSON.parse(raw || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
const groupsOf = p => p._g || (p._g = parseG(p.groups_json));
const regra = g => g.max === 1 ? (g.min ? 'escolha 1' : 'escolha até 1') : (g.min ? `escolha de ${g.min} a ${g.max}` : `escolha até ${g.max}`);

let data;
let lines = [];          // itens do carrinho: {id, qty, obs, picks: {grupo: [opções]}}
let quote = null;        // taxa de entrega calculada pelo endereço
let kind = 'entrega';
let refreshTotals = () => {};

async function load() {
  const r = await fetch('/api/public/' + slug);
  if (!r.ok) { document.body.textContent = 'Loja não encontrada.'; return; }
  data = await r.json();
  document.title = data.store.name + ' — Cardápio';
  const s = data.store;
  $('hd').replaceChildren(
    h('h1', {}, s.name),
    s.store_notice ? h('p', { style: 'color:var(--brand);font-weight:600' }, s.store_notice) : null,
    s.prep_time ? h('p', {}, 'Tempo de preparo: ' + s.prep_time) : null,
    h('p', {}, [s.address, s.city].filter(Boolean).join(' · ')),
    h('span', { class: 'badge ' + (s.is_open ? 'open' : 'closed') }, s.is_open ? 'Aberto agora' : 'Fechado no momento'),
    s.delivery_fee ? h('p', {}, 'Pedido mínimo: ' + brl(s.min_order)) : (s.min_order ? h('p', {}, 'Pedido mínimo: ' + brl(s.min_order)) : null)
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

function qtdNoCarrinho(id) { return lines.filter(l => l.id === id).reduce((a, l) => a + l.qty, 0); }

function card(p) {
  const n = qtdNoCarrinho(p.id);
  const tem = groupsOf(p).length > 0;
  return h('div', { class: 'item' },
    p.image_url ? h('img', { src: p.image_url, alt: '', loading: 'lazy' }) : null,
    h('div', { class: 't' }, h('b', {}, p.name), p.description ? h('small', {}, p.description) : null,
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
        h('span', { class: 'price' }, brl(p.price)),
        !tem && n ? h('span', { class: 'step' }, h('button', { onclick: () => chgSimple(p.id, -1) }, '−'), n, h('button', { onclick: () => chgSimple(p.id, 1) }, '+'))
          : h('button', { class: 'add', onclick: () => (tem ? openConfig(p) : chgSimple(p.id, 1)) }, tem && n ? n + ' no carrinho' : (tem ? 'Escolher' : 'Adicionar')))));
}

// Produto sem adicionais: o + e o − mexem na mesma linha
function chgSimple(id, d) {
  let l = lines.find(x => x.id === id && Object.keys(x.picks).length === 0);
  if (!l && d > 0) { lines.push({ id, qty: 1, obs: '', picks: {} }); }
  else if (l) { l.qty += d; if (l.qty <= 0) lines = lines.filter(x => x !== l); }
  renderMenu(); updateBar();
  if ($('dlg').open && $('dlg').dataset.view === 'checkout') checkout(true);
}

function precoUnit(l) {
  const p = data.products.find(x => x.id === l.id); if (!p) return 0;
  let extra = 0;
  for (const g of groupsOf(p)) for (const it of g.items) if ((l.picks[g.name] || []).includes(it.name)) extra += it.price;
  return p.price + extra;
}
const textoEscolhas = l => Object.entries(l.picks).filter(([, v]) => v.length).map(([g, v]) => g + ': ' + v.join(', ')).join(' · ');
const subtotal = () => lines.reduce((a, l) => a + precoUnit(l) * l.qty, 0);
const totalQtd = () => lines.reduce((a, l) => a + l.qty, 0);

function updateBar() {
  const n = totalQtd();
  $('bar').hidden = !n;
  $('cartN').textContent = `Ver carrinho (${n})`; $('cartT').textContent = brl(subtotal());
}
$('cartBtn').onclick = () => checkout();

// Tela de escolha: adicionais, combos, quantidade e observação
function openConfig(p) {
  const d = $('dlg'); d.dataset.view = 'config';
  const gs = groupsOf(p);
  const picks = {}; gs.forEach(g => picks[g.name] = []);
  let qty = 1, obs = '';
  const erro = h('div', { class: 'err' });
  const precoEl = h('b', {}, '');
  const qtdEl = h('span', {}, '1');
  const total = () => {
    let extra = 0; for (const g of gs) for (const it of g.items) if (picks[g.name].includes(it.name)) extra += it.price;
    return (p.price + extra) * qty;
  };
  const atualiza = () => { precoEl.textContent = brl(total()); qtdEl.textContent = qty; };
  const opcao = (g, it) => {
    const unico = g.max === 1;
    const input = h('input', { type: unico ? 'radio' : 'checkbox', name: 'g' + gs.indexOf(g), onchange: e => {
      if (unico) { picks[g.name] = e.target.checked ? [it.name] : []; }
      else if (e.target.checked) {
        if (picks[g.name].length >= g.max) { e.target.checked = false; erro.textContent = `Em "${g.name}" você pode escolher no máximo ${g.max}.`; return; }
        picks[g.name].push(it.name);
      } else picks[g.name] = picks[g.name].filter(x => x !== it.name);
      erro.textContent = ''; atualiza();
    } });
    return h('label', { style: 'display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)' },
      input, h('span', { style: 'flex:1' }, it.name), h('span', { class: 'muted' }, it.price ? '+ ' + brl(it.price) : 'grátis'));
  };
  d.replaceChildren(h('div', { class: 'pad' },
    h('h3', {}, p.name),
    p.image_url ? h('img', { src: p.image_url, alt: '', style: 'width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:8px' }) : null,
    p.description ? h('p', { class: 'muted' }, p.description) : null,
    gs.map(g => h('div', { style: 'margin-top:14px' }, h('b', {}, g.name), h('span', { class: 'muted', style: 'font-size:13px' }, ' · ' + regra(g)), g.items.map(it => opcao(g, it)))),
    h('label', {}, 'Observação (opcional)'), h('input', { placeholder: 'Ex.: sem cebola', maxlength: 120, oninput: e => { obs = e.target.value; } }),
    h('div', { class: 'row', style: 'margin-top:14px;justify-content:space-between' },
      h('span', { class: 'step' }, h('button', { onclick: () => { if (qty > 1) { qty--; atualiza(); } } }, '−'), qtdEl, h('button', { onclick: () => { if (qty < 50) { qty++; atualiza(); } } }, '+')),
      precoEl),
    erro,
    h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
      h('button', { class: 'btn ghost', onclick: () => { d.close(); renderMenu(); } }, 'Voltar'),
      h('button', { class: 'btn', style: 'flex:1', onclick: () => {
        for (const g of gs) {
          const n = picks[g.name].length;
          if (n < g.min || n > g.max) { erro.textContent = `Em "${g.name}": ${regra(g)}.`; return; }
        }
        const limpo = {}; for (const [k, v] of Object.entries(picks)) if (v.length) limpo[k] = v;
        lines.push({ id: p.id, qty, obs, picks: limpo });
        renderMenu(); updateBar(); d.close();
      } }, 'Adicionar ao carrinho'))));
  atualiza();
  if (!d.open) d.showModal();
}

const PAYLABEL = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega (maquininha)', link: 'Cartão online (link de pagamento)' };

function checkout(keep) {
  const s = data.store, d = $('dlg');
  const antes = keep && $('f_name') ? { n: $('f_name').value, p: $('f_phone').value, a: $('f_addr').value, o: $('f_notes').value, pay: $('f_pay').value, c: $('f_change').value } : null;
  d.dataset.view = 'checkout';
  if (!keep) { quote = null; kind = 'entrega'; }
  const pays = [['pix', s.payments.pix], ['dinheiro', s.payments.cash], ['cartao_entrega', s.payments.card_delivery], ['link', s.payments.link]].filter(x => x[1]).map(x => x[0]);
  const body = h('div', { class: 'pad' }, h('h3', {}, 'Seu pedido'),
    lines.length ? null : h('p', { class: 'muted' }, 'Carrinho vazio.'),
    lines.map((l, i) => {
      const p = data.products.find(x => x.id === l.id); if (!p) return null;
      const txt = textoEscolhas(l);
      return h('div', { class: 'cartline' },
        h('div', { style: 'flex:1;min-width:0' },
          h('b', {}, l.qty + 'x ' + p.name + ' — ' + brl(precoUnit(l) * l.qty)),
          txt ? h('div', { class: 'muted', style: 'font-size:13px' }, txt) : null,
          h('input', { placeholder: 'Observação (ex: sem cebola)', value: l.obs, maxlength: 120, style: 'margin-top:4px;padding:7px', oninput: e => { l.obs = e.target.value; } })),
        h('span', { class: 'step' }, h('button', { onclick: () => lineQty(i, -1) }, '−'), l.qty, h('button', { onclick: () => lineQty(i, 1) }, '+')));
    }),
    h('div', { class: 'seg', style: 'margin-top:14px' },
      ['entrega', 'retirada'].map(k => h('label', {}, h('input', { type: 'radio', name: 'kind', value: k, checked: k === kind, onchange: () => { kind = k; $('addrBox').hidden = k !== 'entrega'; refreshTotals(); } }), h('span', {}, k === 'entrega' ? 'Entrega' : 'Retirada')))),
    h('label', {}, 'Seu nome'), h('input', { id: 'f_name', autocomplete: 'name', value: antes ? antes.n : ls.get('nm') }),
    h('label', {}, 'Telefone / WhatsApp (com DDD)'), h('input', { id: 'f_phone', type: 'tel', autocomplete: 'tel', value: antes ? antes.p : ls.get('ph') }),
    h('div', { id: 'addrBox', hidden: kind !== 'entrega' }, h('label', {}, 'Endereço de entrega (rua, número, bairro)'),
      h('input', { id: 'f_addr', autocomplete: 'street-address', value: antes ? antes.a : ls.get('ad') }),
      h('p', { id: 'qmsg', style: 'color:var(--mute);font-size:13px;margin-top:6px' })),
    h('label', {}, 'Observações do pedido (opcional)'), h('textarea', { id: 'f_notes', rows: 2, maxlength: 250 }, antes ? antes.o : ''),
    h('label', {}, 'Forma de pagamento'),
    h('select', { id: 'f_pay', onchange: e => { $('chBox').hidden = e.target.value !== 'dinheiro'; } }, pays.map(k => h('option', { value: k, selected: antes ? antes.pay === k : k === pays[0] }, PAYLABEL[k]))),
    h('div', { id: 'chBox', hidden: !(antes ? antes.pay === 'dinheiro' : pays[0] === 'dinheiro') }, h('label', {}, 'Troco para quanto? (opcional)'), h('input', { id: 'f_change', placeholder: 'Ex: 50', value: antes ? antes.c : '' })),
    h('div', { style: 'margin-top:14px', id: 'tot' }),
    h('div', { class: 'err', id: 'err' }),
    h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
      h('button', { class: 'btn ghost', onclick: () => d.close() }, 'Voltar'),
      h('button', { class: 'btn', style: 'flex:1', id: 'send', onclick: () => send() }, 'Enviar pedido')));
  d.replaceChildren(body);
  function totals() {
    const fee = kind === 'entrega' && quote ? quote.fee : 0;
    $('tot').replaceChildren(h('div', { class: 'row' }, h('span', {}, 'Subtotal'), h('span', {}, brl(subtotal()))),
      fee ? h('div', { class: 'row' }, h('span', {}, 'Entrega'), h('span', {}, brl(fee))) : (kind === 'entrega' ? h('div', { class: 'row' }, h('span', {}, 'Entrega'), h('span', {}, 'a calcular')) : null),
      h('div', { class: 'row tot' }, h('span', {}, 'Total'), h('span', {}, brl(subtotal() + fee))));
  }
  refreshTotals = totals;
  totals();
  if (quote && $('qmsg')) $('qmsg').textContent = `Distância: ${quote.km} km`;
  $('f_addr').addEventListener('blur', quoteAddr);
  $('f_addr').addEventListener('input', () => { quote = null; totals(); });
  if (!pays.length) { $('err').textContent = 'Esta loja ainda não configurou formas de pagamento.'; $('send').disabled = true; }
  if (!s.is_open) { $('err').textContent = 'A loja está fechada no momento.'; $('send').disabled = true; }
  if (!d.open) d.showModal();
  if (!lines.length) d.close();
}

function lineQty(i, d) {
  lines[i].qty += d;
  if (lines[i].qty <= 0) lines.splice(i, 1);
  renderMenu(); updateBar();
  if (!lines.length) { $('dlg').close(); return; }
  checkout(true);
}

async function quoteAddr() {
  const a = $('f_addr').value.trim();
  $('err').textContent = ''; $('qmsg').textContent = ''; quote = null;
  if (a.length < 6) { $('err').textContent = 'Digite o endereço completo (rua, número, bairro e cidade).'; refreshTotals(); return; }
  $('qmsg').textContent = 'Calculando a taxa...';
  try {
    const r = await fetch(`/api/public/${slug}/quote?address=${encodeURIComponent(a)}`);
    const j = await r.json();
    if (j.error) $('err').textContent = j.error;
    else { quote = j; $('qmsg').textContent = `Distância: ${j.km} km`; }
  } catch { $('err').textContent = 'Sem conexão para calcular a entrega.'; }
  if (!quote) $('qmsg').textContent = '';
  refreshTotals();
}

async function send() {
  if (kind === 'entrega' && !quote) { await quoteAddr(); if (!quote) return; }
  const btn = $('send'); btn.disabled = true; $('err').textContent = '';
  const body = {
    kind, customer_name: $('f_name').value, phone: $('f_phone').value, address: $('f_addr').value, notes: $('f_notes').value,
    payment_method: $('f_pay').value, change_for: $('f_change').value,
    items: lines.map(l => ({ id: l.id, qty: l.qty, obs: l.obs, choices: Object.entries(l.picks).map(([group, picks]) => ({ group, picks })) })),
  };
  try {
    const r = await fetch(`/api/public/${slug}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { $('err').textContent = j.error || 'Erro ao enviar.'; btn.disabled = false; return; }
    ls.set('nm', body.customer_name); ls.set('ph', body.phone); ls.set('ad', body.address);
    lines = []; renderMenu(); done(j, body.payment_method);
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
      h('button', { class: 'btn', onclick: e => { navigator.clipboard?.writeText(j.pix).catch(() => {}); e.target.textContent = 'Copiado!'; } }, 'Copiar código Pix'),
      h('p', { style: 'color:var(--mute);font-size:13px' }, 'O pagamento vai direto para a conta da loja. Depois de pagar, é só aguardar.')) : null,
    method === 'link' ? h('div', {}, h('p', {}, 'Pague com cartão no link da loja. Informe o valor de ' + brl(j.total) + ' e o código #' + j.code + '.'),
      h('a', { class: 'btn', style: 'display:block;text-align:center;text-decoration:none', href: j.payment_link, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir link de pagamento')) : null,
    method === 'dinheiro' ? h('p', {}, 'Pagamento em dinheiro na entrega ou retirada.') : null,
    method === 'cartao_entrega' ? h('p', {}, 'Pagamento com cartão na maquininha, na entrega ou retirada.') : null,
    data.store.whatsapp ? h('a', { class: 'btn ghost', style: 'display:block;text-align:center;text-decoration:none;margin-top:10px', target: '_blank', rel: 'noopener noreferrer',
      href: 'https://wa.me/55' + data.store.whatsapp.replace(/\D/g, '').replace(/^55/, '') + '?text=' + encodeURIComponent('Olá! Fiz o pedido #' + j.code) }, 'Falar com a loja no WhatsApp') : null,
    h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => d.close() }, 'Fechar')));
  const t = setInterval(async () => {
    if (!d.open || d.dataset.view !== 'done') return clearInterval(t);
    try { const r = await fetch(`/api/public/${slug}/orders/${j.code}`); if (r.ok) paint((await r.json()).status); } catch {}
  }, 15000);
}
load();
