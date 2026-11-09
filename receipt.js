'use strict';
// Comanda para impressora térmica (80 mm), no formato de delivery
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const PAY = { pix: 'Pix', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na maquininha', link: 'Cartão online (link)' };
const pixPago = o => o.payment_method !== 'pix' || ['approved', 'manual'].includes(o.mp_status);

function receipt(store, o) {
  const items = JSON.parse(o.items_json || '[]');
  const when = new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const midia = store.print_media !== 0;
  const enderecoLoja = [[store.address, store.numero].filter(Boolean).join(', '), store.bairro, [store.city, store.uf].filter(Boolean).join(' - '), store.cep ? 'CEP ' + store.cep : ''].filter(Boolean).join(' - ');
  const pagto = o.payment_method === 'pix' ? (pixPago(o) ? 'Pix (PAGO)' : 'Pix (AGUARDANDO)') : (PAY[o.payment_method] || o.payment_method);
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Pedido ${esc(o.code)}</title>
<style>
@page{size:80mm auto;margin:0}
*{box-sizing:border-box}
body{width:72mm;margin:0 auto;padding:2mm 0 6mm;font:12px/1.35 'Courier New',monospace;color:#000}
.capa{display:block;width:100%;max-height:30mm;object-fit:cover;margin-bottom:2mm}
.logo{display:block;margin:0 auto 2mm;max-width:40mm;max-height:22mm;object-fit:contain}
.c{text-align:center}
.nome{font-size:16px;font-weight:bold;text-align:center}
.sep{border-top:1px dashed #000;margin:5px 0}
.sep2{border-top:2px solid #000;margin:5px 0}
.pedido{font-size:22px;font-weight:bold;text-align:center;margin:2px 0}
.tipo{font-size:17px;font-weight:bold;text-align:center;border:2px solid #000;padding:2px;margin:4px 0}
.b{font-weight:bold}
.it{display:flex;justify-content:space-between;gap:6px;margin-top:4px;font-size:13px}
.q{font-weight:bold;font-size:15px}
.obs{padding-left:14px;font-size:12px}
.obsb{padding-left:0;margin-top:2px;font-size:13px;font-weight:bold}
.r{display:flex;justify-content:space-between}
.total{display:flex;justify-content:space-between;font-size:18px;font-weight:bold;margin:4px 0}
.pg{font-size:13px}
</style>
<body>
${midia && store.capa_url ? `<img class="capa" src="${esc(store.capa_url)}">` : ''}
${midia && store.logo_url ? `<img class="logo" src="${esc(store.logo_url)}">` : ''}
<div class="nome">${esc(store.name)}</div>
${enderecoLoja ? `<div class="c">${esc(enderecoLoja)}</div>` : ''}
${store.whatsapp ? `<div class="c">Tel: ${esc(store.whatsapp)}</div>` : ''}
<div class="sep2"></div>
<div class="pedido">PEDIDO #${esc(o.code)}</div>
<div class="tipo">${o.kind === 'entrega' ? 'ENTREGA' : 'RETIRADA'}</div>
<div class="c">${esc(when)}</div>
<div class="sep"></div>
<div class="b">CLIENTE: ${esc(o.customer_name)}</div>
<div>Tel: ${esc(o.phone)}</div>
${o.kind === 'entrega' ? `<div class="b" style="margin-top:3px">ENDEREÇO:</div><div>${esc(o.address)}</div>` : ''}
<div class="sep"></div>
${items.map(i => `<div class="it"><span><span class="q">${i.qty}x</span> ${esc(i.name)}</span><span class="b">${brl(i.qty * i.price)}</span></div>${(i.choices ? String(i.choices).split(' · ') : []).filter(Boolean).map(x => `<div class="obs">+ ${esc(x)}</div>`).join('')}${i.obs ? `<div class="obs obsb">OBS: ${esc(i.obs)}</div>` : ''}`).join('')}
<div class="sep"></div>
<div class="r"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
${o.discount ? `<div class="r"><span>Desconto${o.coupon ? ' (' + esc(o.coupon) + ')' : ''}</span><span>-${brl(o.discount)}</span></div>` : ''}
${o.delivery_fee ? `<div class="r"><span>Taxa de entrega</span><span>${brl(o.delivery_fee)}</span></div>` : ''}
<div class="sep2"></div>
<div class="total"><span>TOTAL</span><span>${brl(o.total)}</span></div>
<div class="sep"></div>
<div class="pg">Pagamento: <b>${esc(pagto)}</b></div>
${o.payment_method === 'dinheiro' && o.change_for ? `<div class="pg">Troco para: ${esc(o.change_for)}</div>` : ''}
${o.notes ? `<div class="sep"></div><div class="b">OBS DO PEDIDO:</div><div>${esc(o.notes)}</div>` : ''}
<div class="sep"></div>
<div class="c">Obrigado pela preferência!</div>
<div class="c" style="font-size:10px;margin-top:3px">Pedeaí</div>
<script>addEventListener('load',()=>{setTimeout(()=>{print()},150)});</script></body></html>`;
}

module.exports = { receipt };
