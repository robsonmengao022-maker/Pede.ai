'use strict';
// Mercado Pago com OAuth: cada loja conecta a PRÓPRIA conta. O Pix é criado na conta da loja
// e a confirmação chega pelo webhook. Os tokens das lojas são guardados criptografados.
const crypto = require('crypto');
const MP_URL = process.env.MP_API_URL || 'https://api.mercadopago.com';
const AUTH_URL = process.env.MP_AUTH_URL || 'https://auth.mercadopago.com.br';
const CLIENT_ID = process.env.MP_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MP_CLIENT_SECRET || '';
const KEY = process.env.PEDEAI_KEY ? crypto.createHash('sha256').update(process.env.PEDEAI_KEY).digest() : null;
const SITE = process.env.PUBLIC_URL || 'https://pede-ai-9aun.onrender.com';
const REDIRECT = SITE + '/api/mp/callback';
const WEBHOOK = SITE + '/api/mercadopago/webhook';

// Só funciona quando as três variáveis estão configuradas no Render
const oauthReady = () => !!(CLIENT_ID && CLIENT_SECRET && KEY);

function cifra(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), dados].map(b => b.toString('base64')).join(':');
}
function decifra(bruto) {
  if (!KEY || !bruto) return '';
  const [iv, tag, dados] = String(bruto).split(':').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(dados), d.final()]).toString('utf8');
}

function urlAutorizacao(state) {
  return `${AUTH_URL}/authorization?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&platform_id=mp&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
}

async function pedeToken(corpo) {
  const r = await fetch(MP_URL + '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...corpo }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.message || 'Mercado Pago recusou a conexão (' + r.status + ')');
  return { access_token: j.access_token, refresh_token: j.refresh_token || '', user_id: String(j.user_id || ''), expires_at: Date.now() + (Number(j.expires_in) || 0) * 1000 };
}
const trocaCodigo = code => pedeToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
const renovaToken = refresh => pedeToken({ grant_type: 'refresh_token', refresh_token: refresh });

async function mpFetch(token, path, { method = 'GET', body, idem } = {}) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (idem) headers['X-Idempotency-Key'] = idem;
  const r = await fetch(MP_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Mercado Pago respondeu ' + r.status);
  return j;
}

// Cria a cobrança Pix na conta da loja; devolve o código copia e cola
async function criarPix({ token, amount, description, email, idem }) {
  const p = await mpFetch(token, '/v1/payments', { method: 'POST', idem, body: {
    transaction_amount: Math.round(amount * 100) / 100,
    description: description.slice(0, 100),
    payment_method_id: 'pix',
    payer: { email },
    notification_url: WEBHOOK,
  } });
  return { id: String(p.id), status: p.status, qr: (p.point_of_interaction && p.point_of_interaction.transaction_data && p.point_of_interaction.transaction_data.qr_code) || '' };
}

// Consulta o pagamento direto na API da loja (não confia só no webhook)
async function buscarPagamento(token, id) {
  const p = await mpFetch(token, '/v1/payments/' + encodeURIComponent(String(id)));
  return { id: String(p.id), status: p.status };
}

module.exports = { oauthReady, cifra, decifra, urlAutorizacao, trocaCodigo, renovaToken, criarPix, buscarPagamento };
