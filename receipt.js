'use strict';
// Recibo para impressora térmica (80mm)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const PAY = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega', link: 'Link de pagamento' };
function receipt(store, o) {
  const items = JSON.parse(o.items_json || '[]');
  const when = new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Pedido ${esc(o.code)}</title>
<style>@page{size:80mm auto;margin:0}*{box-sizing:border-box}body{width:72mm;margin:0 auto;padding:3mm 0;font:13px/1.35 'Courier New',monospace;color:#000}
h1{font-size:16px;text-align:center;margin:0 0 4px}.c{text-align:center}hr{border:0;border-top:1px dashed #000;margin:6px 0}
.r{display:flex;justify-content:space-between;gap:6px}.b{font-weight:bold}.big{font-size:15px}.obs{padding-left:10px;font-size:12px}</style>
<body><h1>${esc(store.name)}</h1><div class="c">${esc(when)}</div><hr>
<div class="c big b">PEDIDO #${esc(o.code)}</div><div class="c b">${o.kind === 'entrega' ? 'ENTREGA' : 'RETIRADA'}</div><hr>
<div class="b">${esc(o.customer_name)}</div><div>${esc(o.phone)}</div>${o.kind === 'entrega' ? `<div>${esc(o.address)}</div>` : ''}<hr>
${items.map(i => `<div class="r"><span>${i.qty}x ${esc(i.name)}</span><span>${brl(i.qty * i.price)}</span></div>${i.obs ? `<div class="obs">Obs: ${esc(i.obs)}</div>` : ''}${i.choices ? `<div class="obs">${esc(i.choices)}</div>` : ''}`).join('')}<hr>
<div class="r"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
${o.delivery_fee ? `<div class="r"><span>Entrega</span><span>${brl(o.delivery_fee)}</span></div>` : ''}
<div class="r b big"><span>TOTAL</span><span>${brl(o.total)}</span></div><hr>
<div class="b">Pagamento: ${esc(PAY[o.payment_method] || o.payment_method)}</div>
${o.payment_method === 'dinheiro' && o.change_for ? `<div>Troco para: ${esc(o.change_for)}</div>` : ''}
${o.payment_method === 'pix' ? '<div>Conferir Pix recebido</div>' : ''}
${o.notes ? `<hr><div>Obs: ${esc(o.notes)}</div>` : ''}
<hr><div class="c">Pedeaí</div>
<script>addEventListener('load',()=>{setTimeout(()=>{print()},150)});</script></body></html>`;
}

module.exports = { receipt };
