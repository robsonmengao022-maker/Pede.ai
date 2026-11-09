const slug = location.pathname.split('/')[1];
const ok = v => v != null && v !== '' && v !== 'null' && v !== 'undefined';
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
const regra = g => g.max >= 20 ? 'escolha quantos quiser' : g.max === 1 ? (g.min ? 'escolha 1' : 'escolha até 1') : (g.min ? `escolha de ${g.min} a ${g.max}` : `escolha até ${g.max}`);

let data;
let lines = [];          // itens do carrinho: {id, qty, obs, picks: {grupo: [opções]}}
let quote = null;        // taxa de entrega calculada pelo endereço
let kind = 'entrega';
let refreshTotals = () => {};
let cupom = null;
let vistaAtual = 'cardapio';        // {code, discount} validado pelo servidor

async function load() {
  const r = await fetch('/api/public/' + slug);
  if (!r.ok) { document.body.textContent = 'Loja não encontrada.'; return; }
  data = await r.json();
  document.title = data.store.name + ' — Cardápio';
  const s = data.store;
  $('hd').replaceChildren(...[
    h('h1', {}, s.name),
    s.store_notice ? h('p', { style: 'color:var(--brand);font-weight:600' }, s.store_notice) : null,
    s.prep_time ? h('p', {}, 'Tempo de preparo: ' + s.prep_time) : null,
    h('p', {}, [[s.address, s.numero].filter(ok).join(', '), s.bairro, [s.city, s.uf].filter(ok).join(' / ')].filter(ok).join(' · ')),
    h('span', { class: 'badge ' + (s.is_open ? 'open' : 'closed') }, s.is_open ? 'Aberto agora' : 'Fechado no momento'),
    s.delivery_fee ? h('p', {}, 'Pedido mínimo: ' + brl(s.min_order)) : (s.min_order ? h('p', {}, 'Pedido mínimo: ' + brl(s.min_order)) : null)
  ].filter(Boolean));
  renderMenu();
  avaliaAoVoltar();
}

function renderMenu() {
  const groups = data.categories.map(c => ({ id: c.id, name: c.name, items: data.products.filter(p => p.category_id === c.id) }));
  const rest = data.products.filter(p => !data.categories.some(c => c.id === p.category_id));
  if (rest.length) groups.push({ id: 0, name: groups.length ? 'Outros' : 'Cardápio', items: rest });
  const gs = groups.filter(g => g.items.length);
  $('cats').replaceChildren(...gs.map(g => h('a', { href: '#c' + g.id }, g.name)));
  $('cats').dataset.multi = gs.length >= 2 ? '1' : '';
  $('cats').hidden = gs.length < 2 || vistaAtual !== 'cardapio';
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
  for (const g of groupsOf(p)) for (const nm of (l.picks[g.name] || [])) { const it = g.items.find(x => x.name === nm); if (it) extra += it.price; }
  return p.price + extra;
}
const textoEscolhas = l => Object.entries(l.picks).filter(([, v]) => v.length).map(([g, v]) => g + ': ' + [...new Set(v)].map(nm => nm + (v.filter(x => x === nm).length > 1 ? ' x' + v.filter(x => x === nm).length : '')).join(', ')).join(' · ');
const subtotal = () => lines.reduce((a, l) => a + precoUnit(l) * l.qty, 0);
const totalQtd = () => lines.reduce((a, l) => a + l.qty, 0);

function updateBar() {
  const n = totalQtd();
  $('bar').hidden = !n || vistaAtual !== 'cardapio';
  $('cartN').textContent = `Ver carrinho (${n})`; $('cartT').textContent = brl(subtotal());
}
$('cartBtn').onclick = () => checkout();

// Tela de escolha: adicionais, combos, quantidade e observação
function openConfig(p) {
  const d = $('dlg'); d.dataset.view = 'config';
  d.style.cssText = 'padding:0;max-height:92vh;width:min(560px,100%);display:flex;flex-direction:column;overflow:hidden';
  const gs = groupsOf(p);
  const picks = {}; gs.forEach(g => picks[g.name] = []);
  let qty = 1, obs = '', qtdEl = null, totalEl = null;
  const erro = () => h('div', { class: 'err', id: 'cfgErr' }, '');
  let msg = '';

  const total = () => {
    let extra = 0; for (const g of gs) for (const nm of picks[g.name]) { const it = g.items.find(x => x.name === nm); if (it) extra += it.price; }
    return (p.price + extra) * qty;
  };
  const atualiza = () => { if (totalEl) totalEl.textContent = brl(total()); if (qtdEl) qtdEl.textContent = qty; };

  const circ = sel => 'width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex:0 0 34px;border:none;' +
    (sel ? 'background:var(--brand);color:#fff' : 'border:1.5px solid var(--brand);color:var(--brand);background:#fff');

  // escolha única (combo): toca para marcar/desmarcar
  function marca(g, it) {
    msg = '';
    picks[g.name] = picks[g.name][0] === it.name ? [] : [it.name];
    redraw();
  }
  // adicionais: + e − por opção, respeitando o total do grupo
  function mais(g, it) {
    msg = '';
    if (picks[g.name].length >= g.max) { msg = `Em "${g.name}" você pode escolher no máximo ${g.max}.`; return redraw(); }
    picks[g.name].push(it.name); redraw();
  }
  function menos(g, it) {
    msg = '';
    const i = picks[g.name].lastIndexOf(it.name);
    if (i >= 0) picks[g.name].splice(i, 1);
    redraw();
  }

  const linha = (g, it) => {
    const n = picks[g.name].filter(x => x === it.name).length;
    const nome = h('div', { style: 'flex:1;min-width:0' },
      h('div', { style: 'font-weight:600;text-transform:uppercase;font-size:15px' }, it.name),
      h('div', { style: 'color:var(--brand);font-weight:700;margin-top:4px' }, it.price ? '+ ' + brl(it.price) : 'Grátis'));
    if (g.max === 1) {
      const sel = n > 0;
      return h('div', { style: 'display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);cursor:pointer', onclick: () => marca(g, it) },
        nome, h('span', { style: circ(sel) }, sel ? '✓' : '○'));
    }
    return h('div', { style: 'display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)' },
      nome,
      n > 0
        ? h('span', { class: 'step' }, h('button', { onclick: () => menos(g, it) }, '−'),
            h('span', { style: 'min-width:22px;text-align:center;font-weight:700' }, String(n)),
            h('button', { onclick: () => mais(g, it) }, '+'))
        : h('button', { style: circ(false) + ';cursor:pointer', onclick: () => mais(g, it) }, '+'));
  };

  const secao = g => h('div', { style: 'margin-top:20px' },
    h('div', { style: 'font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase' }, g.name),
    h('div', { class: 'muted', style: 'font-size:13px' },
      g.max === 1 ? (g.min ? 'Obrigatório · escolha 1' : 'Escolha 1') : (g.max >= 20 ? 'Escolha quantos quiser' : `Escolha até ${g.max}`)),
    g.items.map(it => linha(g, it)));

  function corpo() {
    return h('div', { style: 'padding:16px;overflow:auto;flex:1' },
      p.image_url ? h('img', { src: p.image_url, alt: '', style: 'width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:10px' }) : null,
      p.description ? h('p', { class: 'muted', style: 'margin:0 0 6px' }, p.description) : null,
      gs.map(secao),
      h('label', { style: 'margin-top:20px' }, 'Observação (opcional)'),
      h('input', { placeholder: 'Ex.: sem cebola', maxlength: 120, value: obs, oninput: e => { obs = e.target.value; } }),
      h('div', { class: 'err' }, msg));
  }

  function barra() {
    qtdEl = h('span', { style: 'min-width:24px;text-align:center;font-weight:700' }, String(qty));
    totalEl = h('b', {}, brl(total()));
    return h('div', { style: 'border-top:1px solid var(--line);padding:12px 16px;display:flex;align-items:center;gap:10px;background:#fff' },
      h('span', { class: 'step' },
        h('button', { onclick: () => { if (qty > 1) { qty--; redraw(); } } }, '−'), qtdEl,
        h('button', { onclick: () => { if (qty < 50) { qty++; redraw(); } } }, '+')),
      h('button', { class: 'btn', style: 'flex:1;display:flex;justify-content:space-between;align-items:center', onclick: adicionar },
        h('span', {}, 'Adicionar'), totalEl));
  }

  function adicionar() {
    for (const g of gs) {
      const n = picks[g.name].length;
      if (n < g.min || n > g.max) { msg = `Em "${g.name}": ${regra(g)}.`; return redraw(); }
    }
    const limpo = {}; for (const [k, v] of Object.entries(picks)) if (v.length) limpo[k] = v;
    lines.push({ id: p.id, qty, obs, picks: limpo });
    renderMenu(); updateBar(); d.close();
  }

  function redraw() {
    d.replaceChildren(
      h('div', { style: 'background:var(--brand);color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center' },
        h('b', { style: 'font-size:16px' }, p.name),
        h('button', { style: 'background:none;border:0;color:#fff;font-size:22px;padding:0 4px;cursor:pointer', onclick: () => d.close() }, '✕')),
      corpo(), barra());
    atualiza();
  }
  redraw();
  if (!d.open) d.showModal();
}

const PAYLABEL = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega (maquininha)', link: 'Cartão online (link de pagamento)' };

function checkout(keep) {
  const s = data.store, d = $('dlg');
  const antes = keep && $('f_name') ? { n: $('f_name').value, p: $('f_phone').value, end: lerEnd(), o: $('f_notes').value, pay: $('f_pay').value, c: $('f_change').value, cp: $('f_coupon') ? $('f_coupon').value : '' } : null;
  d.dataset.view = 'checkout';
  const pre = antes ? antes.end : lerEndSalvo();
  if (!keep) { quote = null; kind = 'entrega'; cupom = null; }
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
    h('div', { id: 'addrBox', hidden: kind !== 'entrega' },
      h('div', { style: 'display:grid;grid-template-columns:1fr 110px;gap:8px' },
        h('div', {}, h('label', {}, 'CEP'), h('input', { id: 'f_cep', inputmode: 'numeric', autocomplete: 'postal-code', placeholder: '00000-000', maxlength: 9, value: pre.cep || '',
          oninput: e => { const d = e.target.value.replace(/\D/g, '').slice(0, 8); e.target.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d; } })),
        h('div', {}, h('label', {}, 'Número'), h('input', { id: 'f_num', inputmode: 'numeric', value: pre.num || '' }))),
      h('label', {}, 'Rua'), h('input', { id: 'f_rua', autocomplete: 'address-line1', value: pre.rua || '' }),
      h('label', {}, 'Bairro'), h('input', { id: 'f_bairro', value: pre.bairro || '' }),
      h('label', {}, 'Cidade - UF'), h('input', { id: 'f_cid', value: pre.cid || '' }),
      h('label', {}, 'Complemento (opcional)'), h('input', { id: 'f_comp', placeholder: 'Ex: apto 302, bloco B', value: pre.comp || '' }),
      h('p', { id: 'qmsg', style: 'color:var(--mute);font-size:13px;margin-top:6px' })),
    h('label', {}, 'Observações do pedido (opcional)'), h('textarea', { id: 'f_notes', rows: 2, maxlength: 250 }, antes ? antes.o : ''),
    h('label', {}, 'Cupom de desconto (opcional)'),
    h('div', { class: 'row' }, h('input', { id: 'f_coupon', placeholder: 'Ex: BEMVINDO10', maxlength: 30, style: 'flex:1', value: antes ? antes.cp : (cupom ? cupom.code : '') }),
      h('button', { class: 'btn ghost', onclick: () => aplicaCupom() }, 'Aplicar')),
    h('p', { id: 'cmsg', class: 'muted' }),
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
    const desc = cupom ? cupom.discount : 0;
    $('tot').replaceChildren(...[h('div', { class: 'row' }, h('span', {}, 'Subtotal'), h('span', {}, brl(subtotal()))),
      desc ? h('div', { class: 'row' }, h('span', {}, 'Desconto (' + cupom.code + ')'), h('span', {}, '-' + brl(desc))) : null,
      fee ? h('div', { class: 'row' }, h('span', {}, 'Entrega'), h('span', {}, brl(fee))) : (kind === 'entrega' ? h('div', { class: 'row' }, h('span', {}, 'Entrega'), h('span', {}, 'a calcular')) : null),
      h('div', { class: 'row tot' }, h('span', {}, 'Total'), h('span', {}, brl(Math.max(0, subtotal() - desc + fee))))].filter(Boolean));
  }
  refreshTotals = totals;
  totals();
  if (quote && $('qmsg')) $('qmsg').textContent = `Distância: ${quote.km} km`;
  if (cupom && $('cmsg')) $('cmsg').textContent = `Cupom ${cupom.code} aplicado.`;
  ['f_cep', 'f_rua', 'f_num', 'f_comp', 'f_bairro', 'f_cid'].forEach(id => $(id).addEventListener('input', () => { quote = null; totals(); }));
  $('f_cep').addEventListener('blur', buscaCepCliente);
  $('f_num').addEventListener('blur', quoteAddr);
  if (!pays.length) { $('err').textContent = 'Esta loja ainda não configurou formas de pagamento.'; $('send').disabled = true; }
  if (!s.is_open) { $('err').textContent = 'A loja está fechada no momento.'; $('send').disabled = true; }
  if (!d.open) d.showModal();
  if (!lines.length) d.close();
}

// Valida o cupom no servidor (pré-visualização); o pedido revalida ao enviar
async function aplicaCupom() {
  const code = ($('f_coupon') ? $('f_coupon').value : '').trim().toUpperCase();
  const msg = $('cmsg');
  if (!code) { cupom = null; if (msg) msg.textContent = ''; refreshTotals(); return; }
  try {
    const r = await fetch(`/api/public/${slug}/coupon?code=${encodeURIComponent(code)}&subtotal=${subtotal()}`);
    const j = await r.json();
    if (!r.ok) { cupom = null; if (msg) msg.textContent = j.error; }
    else { cupom = j; if (msg) msg.textContent = `Cupom ${j.code} aplicado: -${brl(j.discount)}`; }
  } catch { cupom = null; if (msg) msg.textContent = 'Sem conexão para validar o cupom.'; }
  refreshTotals();
}

function lineQty(i, d) {
  lines[i].qty += d;
  if (lines[i].qty <= 0) lines.splice(i, 1);
  renderMenu(); updateBar();
  if (!lines.length) { $('dlg').close(); return; }
  checkout(true);
}

// Endereço do cliente: CEP, rua, número, bairro, cidade e complemento (igual ao cadastro da loja)
function lerEnd() {
  const v = id => ($(id) ? $(id).value : '');
  return { cep: v('f_cep'), rua: v('f_rua'), num: v('f_num'), comp: v('f_comp'), bairro: v('f_bairro'), cid: v('f_cid') };
}
function lerEndSalvo() { try { return JSON.parse(ls.get('end') || '{}'); } catch { return {}; } }
function fullAddr() {
  const e = lerEnd(), cep = e.cep.replace(/\D/g, '');
  if (!e.rua.trim() || !e.num.trim() || !e.bairro.trim() || cep.length !== 8) return '';
  const linha = e.rua.trim() + ', ' + e.num.trim() + (e.comp.trim() ? ' (' + e.comp.trim() + ')' : '');
  return [linha, e.bairro.trim(), e.cid.trim(), 'CEP ' + cep.slice(0, 5) + '-' + cep.slice(5)].filter(Boolean).join(' - ');
}
async function buscaCepCliente() {
  const cep = lerEnd().cep.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const r = await fetch('https://viacep.com.br/ws/' + cep + '/json/');
    const j = await r.json();
    if (j.erro) { $('err').textContent = 'CEP não encontrado. Confira os números.'; return; }
    $('f_rua').value = j.logradouro || $('f_rua').value;
    $('f_bairro').value = j.bairro || $('f_bairro').value;
    $('f_cid').value = [j.localidade, j.uf].filter(Boolean).join(' - ');
    $('err').textContent = '';
    quote = null; refreshTotals();
    $('f_num').focus();
  } catch { $('err').textContent = 'Não consegui consultar o CEP. Preencha os campos à mão.'; }
}

async function quoteAddr() {
  const a = fullAddr();
  $('err').textContent = ''; $('qmsg').textContent = ''; quote = null;
  if (!a) { if (kind === 'entrega') $('err').textContent = 'Preencha CEP, rua, número e bairro.'; refreshTotals(); return; }
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
    kind, customer_name: $('f_name').value, phone: $('f_phone').value, address: fullAddr(), notes: $('f_notes').value, coupon: $('f_coupon') ? $('f_coupon').value.trim() : '',
    payment_method: $('f_pay').value, change_for: $('f_change').value,
    items: lines.map(l => ({ id: l.id, qty: l.qty, obs: l.obs, choices: Object.entries(l.picks).map(([group, picks]) => ({ group, picks })) })),
  };
  try {
    const r = await fetch(`/api/public/${slug}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { $('err').textContent = j.error || 'Erro ao enviar.'; btn.disabled = false; return; }
    ls.set('nm', body.customer_name); ls.set('ph', body.phone); ls.set('ad', body.address); ls.set('end', JSON.stringify(lerEnd()));
    salvaPedido(j, body.phone);
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
    h('p', { id: 'paidMsg', style: 'color:#15803d;font-weight:700' }),
    method === 'pix' ? h('div', {}, h('b', {}, 'Pague com Pix (copia e cola):'), h('div', { class: 'pix' }, j.pix),
      h('button', { class: 'btn', onclick: e => { navigator.clipboard?.writeText(j.pix).catch(() => {}); e.target.textContent = 'Copiado!'; } }, 'Copiar código Pix'),
      h('p', { style: 'color:var(--mute);font-size:13px' }, 'Pague no app do seu banco. Depois de pagar, acompanhe o status do pedido por aqui.')) : null,
    method === 'link' ? h('div', {}, h('p', {}, 'Pague com cartão no link da loja. Informe o valor de ' + brl(j.total) + ' e o código #' + j.code + '.'),
      h('a', { class: 'btn', style: 'display:block;text-align:center;text-decoration:none', href: j.payment_link, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir link de pagamento')) : null,
    method === 'dinheiro' ? h('p', {}, 'Pagamento em dinheiro na entrega ou retirada.') : null,
    method === 'cartao_entrega' ? h('p', {}, 'Pagamento com cartão na maquininha, na entrega ou retirada.') : null,
    data.store.whatsapp ? h('a', { class: 'btn ghost', style: 'display:block;text-align:center;text-decoration:none;margin-top:10px', target: '_blank', rel: 'noopener noreferrer',
      href: 'https://wa.me/55' + data.store.whatsapp.replace(/\D/g, '').replace(/^55/, '') + '?text=' + encodeURIComponent('Olá! Fiz o pedido #' + j.code) }, 'Falar com a loja no WhatsApp') : null,
    h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => d.close() }, 'Fechar')));
  const t = setInterval(async () => {
    if (!d.open || d.dataset.view !== 'done') return clearInterval(t);
    try { const r = await fetch(`/api/public/${slug}/orders/${j.code}`); if (r.ok) { const o = await r.json(); paint(o.status); if (o.paid && $('paidMsg')) $('paidMsg').textContent = 'Pagamento confirmado ✅'; } } catch {}
  }, 15000);
}
// ----- abas do rodapé, pedidos neste aparelho e avaliação -----
const pedidosKey = () => 'pedidos_' + slug;
function pedidosLocais() { try { return JSON.parse(localStorage.getItem(pedidosKey()) || '[]'); } catch { return []; } }
function gravaPedidos(l) { try { localStorage.setItem(pedidosKey(), JSON.stringify(l.slice(0, 30))); } catch {} }
function salvaPedido(j, phone) { gravaPedidos([{ code: j.code, total: j.total, phone, at: Date.now() }, ...pedidosLocais().filter(x => x.code !== j.code)]); }
function marcaPedido(code, patch) { gravaPedidos(pedidosLocais().map(x => x.code === code ? { ...x, ...patch } : x)); }
const estrelas = n => '★'.repeat(n) + '☆'.repeat(5 - n);

function mostra(v) {
  vistaAtual = v;
  const mapa = { cardapio: ['hd', 'cats', 'menu'], pedidos: ['v_pedidos'], aval: ['v_aval'], perfil: ['v_perfil'] };
  for (const id of ['hd', 'cats', 'menu', 'v_pedidos', 'v_aval', 'v_perfil']) $(id).hidden = !mapa[v].includes(id);
  if (v === 'cardapio') { $('cats').hidden = !$('cats').dataset.multi; updateBar(); }
  else $('bar').hidden = true;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo(0, 0);
  if (v === 'pedidos') viewPedidos();
  if (v === 'aval') viewAval();
  if (v === 'perfil') viewPerfil();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => mostra(b.dataset.v)));

const STATUS_TXT = { novo: 'Recebido', preparando: 'Preparando', saiu: 'Saiu / pronto', entregue: 'Entregue', cancelado: 'Cancelado' };
async function viewPedidos() {
  const v = $('v_pedidos');
  const l = pedidosLocais();
  v.replaceChildren(h('h2', {}, 'Meus pedidos'), h('p', { class: 'muted' }, 'Pedidos feitos neste aparelho.'));
  if (!l.length) { v.append(h('p', { class: 'muted', style: 'margin-top:16px' }, 'Você ainda não fez nenhum pedido aqui.')); return; }
  for (const p of l) {
    const situacao = h('span', { class: 'muted' }, 'Carregando...');
    const box = h('div', { class: 'item', style: 'flex-direction:column;gap:6px' }, h('b', {}, '#' + p.code + ' · ' + brl(p.total)), situacao);
    v.append(box);
    fetch(`/api/public/${slug}/orders/${p.code}`).then(r => r.ok ? r.json() : null).then(o => {
      if (!o) { situacao.textContent = 'Pedido não encontrado'; return; }
      situacao.replaceWith(h('span', {}, 'Situação: ', h('b', {}, STATUS_TXT[o.status] || o.status)));
      if (o.itens && o.itens.length) box.append(h('span', { class: 'muted' }, o.itens.join(' · ')));
      if (o.rating) box.append(h('span', { style: 'color:#f59e0b' }, estrelas(o.rating) + ' · sua avaliação'));
      else if (o.status === 'entregue') box.append(h('button', { class: 'btn', onclick: () => abreAvaliacao(p, false) }, 'Avaliar pedido'));
    }).catch(() => { situacao.textContent = 'Sem conexão'; });
  }
}

function abreAvaliacao(p, automatico) {
  const d = $('dlg'); d.dataset.view = 'rate';
  let nota = 0;
  const erro = h('p', { class: 'err' });
  const barra = h('div', { style: 'font-size:38px;letter-spacing:6px;text-align:center;margin:12px 0' });
  const pinta = () => barra.replaceChildren(...[1, 2, 3, 4, 5].map(n => h('span', { style: 'cursor:pointer;color:' + (n <= nota ? '#f59e0b' : '#d1d5db'), onclick: () => { nota = n; pinta(); } }, '★')));
  pinta();
  const comentario = h('textarea', { rows: 3, placeholder: 'Conte como foi (opcional)', style: 'width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;font:inherit' });
  const enviar = h('button', { class: 'btn', style: 'width:100%;margin-top:12px', onclick: async () => {
    if (!nota) { erro.textContent = 'Toque em uma estrela.'; return; }
    enviar.disabled = true;
    try {
      const r = await fetch(`/api/public/${slug}/orders/${p.code}/avaliar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: nota, comment: comentario.value, phone: p.phone }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { erro.textContent = j.error || 'Não foi possível enviar.'; enviar.disabled = false; return; }
      marcaPedido(p.code, { avaliado: true });
      d.close();
      if (vistaAtual === 'pedidos') viewPedidos();
    } catch { erro.textContent = 'Sem conexão. Tente novamente.'; enviar.disabled = false; }
  } }, 'Enviar avaliação');
  d.replaceChildren(h('div', { class: 'pad' },
    h('h3', {}, 'Como foi seu pedido #' + p.code + '?'),
    h('p', { class: 'muted' }, 'Sua avaliação ajuda outros clientes.'),
    barra, comentario, erro, enviar,
    automatico ? h('button', { class: 'btn ghost', style: 'width:100%;margin-top:10px', onclick: () => { marcaPedido(p.code, { pulou: true }); d.close(); } }, 'Agora não') : null));
  if (!d.open) d.showModal();
}

// ao voltar ao site, pergunta sobre o último pedido entregue que ainda não foi avaliado
async function avaliaAoVoltar() {
  const pendentes = pedidosLocais().filter(x => !x.avaliado && !x.pulou).slice(0, 5);
  for (const p of pendentes) {
    try {
      const r = await fetch(`/api/public/${slug}/orders/${p.code}`);
      if (!r.ok) continue;
      const o = await r.json();
      if (o.rating) { marcaPedido(p.code, { avaliado: true }); continue; }
      if (o.status === 'entregue') { abreAvaliacao(p, true); return; }
    } catch {}
  }
}

async function viewAval() {
  const v = $('v_aval');
  v.replaceChildren(h('h2', {}, 'Avaliações'), h('p', { class: 'muted' }, 'Carregando...'));
  try {
    const r = await fetch(`/api/public/${slug}/avaliacoes`);
    const j = await r.json();
    const media = Math.round(j.media || 0);
    v.replaceChildren(h('h2', {}, 'Avaliações'),
      h('div', { class: 'item', style: 'flex-direction:column;align-items:center;text-align:center' },
        h('div', { style: 'font-size:40px;font-weight:800' }, j.total ? String(j.media).replace('.', ',') : '—'),
        h('div', { style: 'color:#f59e0b;font-size:22px' }, estrelas(media)),
        h('div', { class: 'muted' }, j.total + (j.total === 1 ? ' avaliação' : ' avaliações'))),
      ...(j.lista.length
        ? j.lista.map(a => h('div', { class: 'item', style: 'flex-direction:column;gap:4px' },
            h('div', { style: 'color:#f59e0b' }, estrelas(a.rating)),
            a.rating_comment ? h('div', {}, a.rating_comment) : null,
            h('div', { class: 'muted', style: 'font-size:12px' }, 'Cliente · ' + new Date(a.rated_at.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR'))))
        : [h('p', { class: 'muted' }, 'Ainda não há avaliações.')]));
  } catch { v.replaceChildren(h('h2', {}, 'Avaliações'), h('p', { class: 'err' }, 'Não foi possível carregar.')); }
}

function viewPerfil() {
  const apagar = () => { ['nm', 'ph', 'ad'].forEach(k => { try { localStorage.removeItem(k); } catch {} }); try { localStorage.removeItem(pedidosKey()); } catch {} viewPerfil(); };
  $('v_perfil').replaceChildren(h('h2', {}, 'Perfil'),
    h('div', { class: 'item', style: 'flex-direction:column;gap:6px' },
      h('b', {}, ls.get('nm') || 'Sem cadastro neste aparelho'),
      ls.get('ph') ? h('span', { class: 'muted' }, ls.get('ph')) : null,
      ls.get('ad') ? h('span', { class: 'muted' }, ls.get('ad')) : null),
    h('button', { class: 'btn ghost', style: 'width:100%', onclick: apagar }, 'Apagar meus dados neste aparelho'));
}

load();
