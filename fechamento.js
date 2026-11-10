'use strict';
// Fechamento de caixa automático, todo dia às 02:00 (horário de Brasília, UTC-3, sem horário de verão).
// Cada fechamento cobre os pedidos das 02:00 do dia anterior até as 02:00 do dia, e é enviado para o e-mail da loja.

const HORA_FECHAMENTO = 3; // horário de Brasília em que o fechamento é enviado
const brl = v => 'R$ ' + ((Math.round(Number(v || 0) * 100)) / 100).toFixed(2).replace('.', ',');
const cents = v => Math.round(Number(v || 0) * 100);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGTO = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Maquininha', link: 'Link' };

// created_at vem em UTC ("AAAA-MM-DD HH:MM:SS"); mostra o horário de Brasília
function hora(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(11, 16);
}

// Janela do fechamento que acontece às 02:00 de "dia" (AAAA-MM-DD, horário de Brasília)
function janela(dia) {
  const fim = new Date(dia + 'T' + String(HORA_FECHAMENTO + 3).padStart(2, '0') + ':00:00Z'); // horário local em UTC-3
  const ini = new Date(fim.getTime() - 24 * 3600e3);
  const f = d => d.toISOString().slice(0, 19).replace('T', ' ');
  return { ini: f(ini), fim: f(fim) };
}

function relatorio(store, pedidos, dia) {
  const validos = [];
  let pixNaoPago = 0;
  for (const o of pedidos) {
    if (o.status === 'cancelado') continue;
    if (o.payment_method === 'pix' && !['approved', 'manual'].includes(o.mp_status)) { pixNaoPago++; continue; }
    validos.push(o);
  }
  const soma = { maquininha: 0, pix: 0, dinheiro: 0, outros: 0 };
  let bruto = 0, taxas = 0, entregas = 0;
  for (const o of validos) {
    const t = cents(o.total);
    bruto += t;
    taxas += cents(o.delivery_fee);
    if (o.kind === 'entrega') entregas++;
    if (o.payment_method === 'cartao_entrega') soma.maquininha += t;
    else if (o.payment_method === 'pix') soma.pix += t;
    else if (o.payment_method === 'dinheiro') soma.dinheiro += t;
    else soma.outros += t;
  }
  const v = c => brl(c / 100);

  const linhas = validos.map(o => {
    const itens = (o.items || []).map(i =>
      `<li>${esc(i.qty)}x ${esc(i.name)}${i.choices ? ` <span style="color:#666">(${esc(i.choices)})</span>` : ''}${i.obs ? ` <em>obs: ${esc(i.obs)}</em>` : ''}</li>`).join('');
    const taxa = o.kind === 'entrega' && cents(o.delivery_fee) ? ` · taxa motoboy ${brl(o.delivery_fee)}` : '';
    return `<div style="border-bottom:1px solid #ddd;padding:8px 0">
      <b>Pedido ${esc(o.code)}</b> · ${hora(o.created_at)} · ${o.kind === 'entrega' ? 'Entrega' : 'Retirada'} · ${PAGTO[o.payment_method] || esc(o.payment_method)}
      <ul style="margin:4px 0 0 18px">${itens}</ul>
      <div>Total: <b>${brl(o.total)}</b>${taxa}</div></div>`;
  }).join('') || '<p>Nenhum pedido neste período.</p>';

  const [y, m, d] = dia.split('-');
  const ontem = new Date(Date.UTC(+y, +m - 1, +d) - 24 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/');
  const hoje = [d, m, y].join('/');

  return `<div style="font-family:Arial,sans-serif;max-width:600px">
  <h2 style="margin:0 0 4px">Fechamento de caixa — ${esc(store.name)}</h2>
  <p style="margin:0 0 16px;color:#555">Período: ${ontem} ${String(HORA_FECHAMENTO).padStart(2, '0')}:00 até ${hoje} ${String(HORA_FECHAMENTO).padStart(2, '0')}:00</p>
  <h3>Pedidos</h3>${linhas}
  <h3>Resumo</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr><td>Maquininha (cartão na entrega)</td><td style="text-align:right">${v(soma.maquininha)}</td></tr>
    <tr><td>Pix</td><td style="text-align:right">${v(soma.pix)}</td></tr>
    <tr><td>Dinheiro</td><td style="text-align:right">${v(soma.dinheiro)}</td></tr>
    ${soma.outros ? `<tr><td>Outros</td><td style="text-align:right">${v(soma.outros)}</td></tr>` : ''}
    <tr><td><b>Total com taxa de entrega</b></td><td style="text-align:right"><b>${v(bruto)}</b></td></tr>
    <tr><td>Taxa de entrega (motoboy)</td><td style="text-align:right">${v(taxas)}</td></tr>
    <tr><td><b>Total sem taxa de entrega</b></td><td style="text-align:right"><b>${v(bruto - taxas)}</b></td></tr>
    <tr><td>Pedidos de entrega</td><td style="text-align:right">${entregas}</td></tr>
    <tr><td>Pedidos válidos</td><td style="text-align:right">${validos.length}</td></tr>
  </table>
  ${pixNaoPago ? `<p style="color:#777">${pixNaoPago} pedido(s) Pix sem pagamento confirmado ficaram de fora.</p>` : ''}
  </div>`;
}

// Gera e envia o fechamento de uma loja para um dia (AAAA-MM-DD)
async function fechaCaixa({ db, sendMail }, store, dia) {
  const w = janela(dia);
  const pedidos = db.prepare('SELECT * FROM orders WHERE store_id=? AND created_at>=? AND created_at<? ORDER BY id')
    .all(store.id, w.ini, w.fim).map(o => ({ ...o, items: JSON.parse(o.items_json || '[]') }));
  const html = relatorio(store, pedidos, dia);
  const [y, m, d] = dia.split('-');
  await sendMail(store.email, `Fechamento de caixa — ${store.name} — ${d}/${m}/${y}`, html);
  return { pedidos: pedidos.length };
}

// Verifica a cada minuto; às 02:00 (até 02:10) envia o fechamento de cada loja que ainda não recebeu hoje
function agendaFechamento(deps) {
  deps.db.exec('CREATE TABLE IF NOT EXISTS fechamentos(store_id INTEGER, dia TEXT, enviado_em TEXT, PRIMARY KEY(store_id, dia))');
  const tick = async () => {
    const loc = new Date(Date.now() - 3 * 3600e3);
    if (loc.getUTCHours() !== HORA_FECHAMENTO || loc.getUTCMinutes() > 10) return;
    const dia = loc.toISOString().slice(0, 10);
    const lojas = deps.db.prepare('SELECT * FROM stores WHERE id NOT IN (SELECT store_id FROM fechamentos WHERE dia=?)').all(dia);
    for (const s of lojas) {
      try {
        await fechaCaixa(deps, s, dia);
        deps.db.prepare("INSERT INTO fechamentos(store_id,dia,enviado_em) VALUES(?,?,datetime('now'))").run(s.id, dia);
      } catch (e) { console.error('Fechamento de caixa:', s.slug, e.message); }
    }
  };
  setInterval(() => tick().catch(() => {}), 60e3).unref();
}

module.exports = { agendaFechamento, fechaCaixa, relatorio, janela };
