'use strict';
// Mercado Pago (Pix via API). Enquanto as lojas não conectam a própria conta (OAuth),
// usa o Access Token configurado em MP_ACCESS_TOKEN.
const MP_URL = process.env.MP_API_URL || 'https://api.mercadopago.com';
const TOKEN = process.env.MP_ACCESS_TOKEN || '';
const SITE = process.env.PUBLIC_URL || 'https://pede-ai-9aun.onrender.com';

const mpReady = () => !!TOKEN;

async function mpFetch(path, { method = 'GET', body, idem } = {}) {
  const headers = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  if (idem) headers['X-Idempotency-Key'] = idem;
  const r = await fetch(MP_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Mercado Pago respondeu ' + r.status);
  return j;
}

// Cria a cobrança Pix; devolve o código copia e cola
async function criarPix({ amount, description, email, idem }) {
  const p = await mpFetch('/v1/payments', { method: 'POST', idem, body: {
    transaction_amount: Math.round(amount * 100) / 100,
    description: description.slice(0, 100),
    payment_method_id: 'pix',
    payer: { email },
    notification_url: SITE + '/api/mercadopago/webhook',
  } });
  return { id: String(p.id), status: p.status, qr: (p.point_of_interaction && p.point_of_interaction.transaction_data && p.point_of_interaction.transaction_data.qr_code) || '' };
}

// Consulta o pagamento direto na API (não confia no conteúdo do webhook)
async function buscarPagamento(id) {
  const p = await mpFetch('/v1/payments/' + encodeURIComponent(String(id)));
  return { id: String(p.id), status: p.status };
}

module.exports = { mpReady, criarPix, buscarPagamento };
