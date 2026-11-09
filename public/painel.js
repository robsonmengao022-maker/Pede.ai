const $ = id => document.getElementById(id);
const brl = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'checked' || k === 'value' || k === 'disabled') e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const put = (el, ...k) => el.replaceChildren(...k.flat().filter(c => c != null && c !== false));
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { showAuth(); throw new Error('login'); }
  if (!r.ok) throw new Error(j.error || 'Erro');
  return j;
}
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

function showReset(step = 'mail', email = '') {
  const enviar = async () => {
    try { await api('/forgot', 'POST', { email: $('r_mail').value.trim() }); showReset('code', $('r_mail').value.trim()); }
    catch (e) { $('r_err').textContent = e.message; }
  };
  const trocar = async () => {
    try {
      await api('/reset', 'POST', { email, code: $('r_code').value.trim(), password: $('r_pw').value });
      $('r_err').className = 'msg ok'; $('r_err').textContent = 'Senha trocada! Entre com a nova senha.';
      setTimeout(() => showAuth('login'), 1500);
    } catch (e) { $('r_err').textContent = e.message; }
  };
  $('app').replaceChildren(h('div', { class: 'auth card' },
    h('h1', { style: 'margin:0 0 4px' }, 'Recuperar senha'),
    step === 'mail'
      ? [h('p', { class: 'muted' }, 'Digite o e-mail da sua conta. Vamos enviar um código de 6 números.'), h('label', {}, 'E-mail'), h('input', { id: 'r_mail', type: 'email', autocomplete: 'email' }), h('button', { class: 'btn', style: 'width:100%;margin-top:12px', onclick: enviar }, 'Enviar código')]
      : [h('p', { class: 'muted' }, 'Digite o código que chegou no e-mail e a nova senha.'), h('label', {}, 'Código'), h('input', { id: 'r_code', inputmode: 'numeric', maxlength: 6 }), h('label', {}, 'Nova senha (mínimo 8 caracteres)'), h('input', { id: 'r_pw', type: 'password', autocomplete: 'new-password' }), h('button', { class: 'btn', style: 'width:100%;margin-top:12px', onclick: trocar }, 'Trocar senha')],
    h('div', { class: 'msg err', id: 'r_err' }),
    h('p', { class: 'muted', style: 'text-align:center' }, h('a', { href: '#', onclick: e => { e.preventDefault(); showAuth('login'); } }, 'Voltar ao login'))));
}

// ---------- Login / cadastro ----------
function showAuth(mode = 'login') {
  const signup = mode === 'signup';
  $('app').replaceChildren(h('div', { class: 'auth card' },
    h('h1', { style: 'margin:0 0 4px' }, 'Pedeaí'), h('p', { class: 'muted' }, signup ? 'Crie a conta da sua loja' : 'Entre no painel da sua loja'),
    signup ? [h('label', {}, 'Nome da loja'), h('input', { id: 'a_name' }), h('label', {}, 'WhatsApp da loja'), h('input', { id: 'a_wa', type: 'tel' })] : null,
    h('label', {}, 'E-mail'), h('input', { id: 'a_mail', type: 'email', autocomplete: 'email' }),
    h('label', {}, 'Senha' + (signup ? ' (mínimo 8 caracteres)' : '')), h('input', { id: 'a_pw', type: 'password', autocomplete: signup ? 'new-password' : 'current-password' }),
    h('div', { class: 'msg err', id: 'a_err' }),
    h('button', { class: 'btn', style: 'width:100%', onclick: async () => {
      try {
        await api(signup ? '/signup' : '/login', 'POST', { name: signup && $('a_name').value, whatsapp: signup && $('a_wa').value, email: $('a_mail').value, password: $('a_pw').value });
        start(signup ? 'config' : 'pedidos');
      } catch (e) { $('a_err').textContent = e.message; }
    } }, signup ? 'Criar minha loja' : 'Entrar'),
    h('p', { class: 'muted', style: 'text-align:center' }, signup ? 'Já tem conta? ' : 'Ainda não tem conta? ',
      h('a', { href: '#', onclick: e => { e.preventDefault(); showAuth(signup ? 'login' : 'signup'); } }, signup ? 'Entrar' : 'Criar conta grátis')), signup ? null : h('p', { class: 'muted', style: 'text-align:center' }, h('a', { href: '#', onclick: e => { e.preventDefault(); showReset(); } }, 'Esqueci minha senha'))));
}

// ---------- Estrutura principal ----------
let me, tab = 'pedidos', orders = [], es, audioCtx;
async function start(t) {
  try { me = await api('/me'); } catch { return; }
  tab = t || tab; render();
  connect(); loadOrders();
}
function render() {
  const tabs = [['pedidos', 'Pedidos'], ['cardapio', 'Cardápio'], ['config', 'Configurações'], ['mensalidade', 'Mensalidade']];
  $('app').replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, me.name + ' ', h('span', {}, '· Pedeaí')),
      h('div', { class: 'row' }, h('a', { class: 'btn g s', href: '/' + me.slug, target: '_blank', style: 'text-decoration:none' }, 'Ver meu site'),
        h('button', { class: 'btn g s', onclick: async () => { await api('/logout', 'POST'); es && es.close(); showAuth(); } }, 'Sair'))),
    h('div', { class: 'tabs' }, tabs.map(([k, n]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; render(); } }, n))),
    h('div', { id: 'view' }));
  ({ pedidos: viewOrders, cardapio: viewMenu, config: viewConfig, mensalidade: viewBilling })[tab]();
}

// ---------- Pedidos ----------
const NEXT = { novo: ['preparando', 'Aceitar e preparar'], preparando: ['saiu', 'Saiu para entrega / pronto'], saiu: ['entregue', 'Marcar entregue'] };
const SLABEL = { novo: 'NOVO', preparando: 'Preparando', saiu: 'Saiu / pronto', entregue: 'Entregue', cancelado: 'Cancelado' };
const PAY = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega', link: 'Link de pagamento' };
async function loadOrders() { try { orders = await api('/orders'); if (tab === 'pedidos') viewOrders(); } catch {} }
function viewOrders() {
  const v = $('view'); if (!v) return;
  const active = orders.filter(o => !['entregue', 'cancelado'].includes(o.status));
  const hist = orders.filter(o => ['entregue', 'cancelado'].includes(o.status));
  put(v, 
    h('div', { class: 'card' },
      h('div', { class: 'chk' }, h('input', { type: 'checkbox', id: 'snd', checked: ls.get('snd', '1') === '1', onchange: e => { ls.set('snd', e.target.checked ? '1' : '0'); if (e.target.checked) beep(); } }), h('label', { for: 'snd', style: 'margin:0;color:inherit' }, 'Tocar som quando chegar pedido')),
      h('div', { class: 'chk' }, h('input', { type: 'checkbox', id: 'aprint', checked: ls.get('aprint', '0') === '1', onchange: e => ls.set('aprint', e.target.checked ? '1' : '0') }), h('label', { for: 'aprint', style: 'margin:0;color:inherit' }, 'Imprimir automaticamente cada pedido novo')),
      h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Mantenha esta página aberta no computador da loja. Para imprimir sem janela de confirmação, veja o passo a passo da impressora no README.')),
    h('h2', { style: 'font-size:17px' }, 'Em andamento (' + active.length + ')'),
    active.length ? active.map(orderCard) : h('p', { class: 'muted' }, 'Nenhum pedido em andamento. Seu link: ' + location.origin + '/' + me.slug),
    hist.length ? [h('h2', { style: 'font-size:17px' }, 'Finalizados (últimos 2 dias)'), hist.slice(0, 40).map(orderCard)] : null);
}
const pixPago = o => o.payment_method !== 'pix' || ['approved', 'manual'].includes(o.mp_status);
const pixPendente = o => !pixPago(o) && o.status !== 'cancelado';
async function confirmaPix(o) {
  if (!confirm('Confirme só se o Pix já caiu na sua conta. Confirmar?')) return;
  try { await api(`/orders/${o.id}/pix-confirmar`, 'POST'); o.mp_status = 'manual'; viewOrders(); } catch (e) { alert(e.message); }
}
function orderCard(o) {
  const pend = pixPendente(o);
  const nx = NEXT[o.status];
  return h('div', { class: 'card order ' + o.status },
    h('h3', {}, h('span', {}, '#' + o.code + ' · ' + o.customer_name), h('span', { class: 'tag' }, pend ? 'AGUARDANDO PIX' : SLABEL[o.status])),
    h('div', { class: 'muted' }, new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) + ' · ' + (o.kind === 'entrega' ? 'Entrega' : 'Retirada') + ' · ' + o.phone),
    o.kind === 'entrega' ? h('div', {}, '📍 ' + o.address) : null,
    h('ul', {}, o.items.map(i => h('li', {}, i.qty + 'x ' + i.name + ' — ' + brl(i.qty * i.price), i.obs ? h('div', { class: 'muted' }, 'Obs: ' + i.obs) : null, i.choices ? h('div', { class: 'muted' }, i.choices) : null))),
    o.notes ? h('div', { class: 'muted' }, 'Obs do pedido: ' + o.notes) : null,
    h('div', {}, h('b', {}, 'Total ' + brl(o.total)), ' · ' + PAY[o.payment_method] + (o.change_for ? ' (troco p/ ' + o.change_for + ')' : '')),
    h('div', { class: 'acts' },
      pend ? h('button', { class: 'btn s', onclick: () => confirmaPix(o) }, 'Pix recebido: confirmar') : null,
      nx && !pend ? h('button', { class: 'btn s', onclick: () => setStatus(o, nx[0]) }, nx[1]) : null,
      pend ? null : h('button', { class: 'btn g s', onclick: () => printOrder(o.id) }, '🖨 Imprimir'),
      h('a', { class: 'btn g s', style: 'text-decoration:none', target: '_blank', rel: 'noopener noreferrer', href: 'https://wa.me/55' + o.phone.replace(/\D/g, '').replace(/^55/, '') }, 'WhatsApp'),
      ['novo', 'preparando'].includes(o.status) ? h('button', { class: 'btn r s', onclick: () => confirm('Cancelar este pedido?') && setStatus(o, 'cancelado') }, 'Cancelar') : null));
}
async function setStatus(o, s) {
  try { await api(`/orders/${o.id}/status`, 'PUT', { status: s }); o.status = s; viewOrders(); } catch (e) { alert(e.message); }
}
function printOrder(id) {
  const f = h('iframe', { src: '/recibo/' + id, style: 'position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none' });
  document.body.append(f); setTimeout(() => f.remove(), 60000);
}
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(t => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = 880; g.gain.setValueAtTime(0.2, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.2);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.2); });
  } catch {}
}
function connect() {
  es && es.close();
  es = new EventSource('/api/events');
  es.addEventListener('order', e => {
    const o = JSON.parse(e.data);
    const antigo = orders.find(x => x.id === o.id);
    const jaPago = antigo ? pixPago(antigo) : false;
    if (antigo) Object.assign(antigo, o); else orders.unshift(o);
    if (!antigo && ls.get('snd', '1') === '1') beep();
    // imprime quando o pedido nasce pago, ou quando um Pix pendente é confirmado
    if (ls.get('aprint', '0') === '1' && pixPago(o) && !jaPago) printOrder(o.id);
    document.title = '🔔 Novo pedido! — Pedeaí';
    if (tab === 'pedidos') viewOrders();
  });
  es.onopen = () => loadOrders();
}
addEventListener('focus', () => { document.title = 'Painel do lojista — Pedeaí'; });
