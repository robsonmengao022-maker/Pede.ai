'use strict';
// Backup diário do banco por e-mail (anexo). Envia para BACKUP_EMAIL (configurar no Render).
const fs = require('node:fs');
const path = require('node:path');
const { mailReady } = require('./mail');

// Gera uma cópia completa e consistente do banco e envia por e-mail
async function enviaBackup({ db, sendMail, dataDir }) {
  if (!process.env.BACKUP_EMAIL) throw new Error('Configure BACKUP_EMAIL no Render para receber o backup.');
  if (!mailReady()) throw new Error('E-mail não configurado (BREVO_API_KEY e MAIL_FROM).');
  const tmp = path.join(dataDir, 'backup-tmp.db');
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const agora = new Date(Date.now() - 3 * 3600e3);
  const dia = agora.toISOString().slice(0, 10);
  const hora = agora.toISOString().slice(11, 16);
  const lojas = db.prepare('SELECT COUNT(*) AS n FROM stores').get().n;
  const pedidos = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const html = `<p>Backup automático do Pedeaí, ${dia} às ${hora} (horário de Brasília).</p>
    <p>Lojas: <b>${lojas}</b> · Pedidos: <b>${pedidos}</b></p>
    <p>Guarde este arquivo. Ele tem dados de clientes. Para restaurar, use a tela de Backup no painel de administrador.</p>`;
  await sendMail(process.env.BACKUP_EMAIL, `Backup Pedeaí — ${dia} ${hora}`, html,
    [{ name: `pedeai-${dia}-${hora.replace(':', 'h')}.db`, content: buf.toString('base64') }]);
  return { lojas, pedidos, bytes: buf.length, dia, hora };
}

// Todo dia às 04:00 (Brasília), uma vez por dia. Horário fixo UTC-3, sem horário de verão.
function agendaBackup(deps) {
  deps.db.exec('CREATE TABLE IF NOT EXISTS backups(dia TEXT PRIMARY KEY, enviado_em TEXT)');
  const tick = async () => {
    const loc = new Date(Date.now() - 3 * 3600e3);
    if (loc.getUTCHours() !== 4 || loc.getUTCMinutes() > 10) return;
    const dia = loc.toISOString().slice(0, 10);
    if (deps.db.prepare('SELECT 1 FROM backups WHERE dia=?').get(dia)) return;
    try {
      await enviaBackup(deps);
      deps.db.prepare("INSERT INTO backups(dia,enviado_em) VALUES(?,datetime('now'))").run(dia);
    } catch (e) { console.error('Backup diário:', e.message); }
  };
  setInterval(() => tick().catch(() => {}), 60e3).unref();
}

module.exports = { enviaBackup, agendaBackup };
