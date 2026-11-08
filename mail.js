'use strict';
// Envio de e-mail pelo Brevo (plano gratuito). Sem BREVO_API_KEY e MAIL_FROM, a recuperação de senha fica desligada.
const BREVO_URL = process.env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email';
const mailReady = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);

async function sendMail(to, subject, html) {
  const r = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: process.env.MAIL_FROM, name: 'Pedeaí' }, to: [{ email: to }], subject, htmlContent: html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('envio de e-mail falhou: ' + r.status);
}

module.exports = { sendMail, mailReady };
