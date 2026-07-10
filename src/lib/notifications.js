'use strict';

const { db } = require('../db');

// Crea una notificación para un usuario
function notify(userId, { title, body, link }) {
  if (!userId || !title) return;
  db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)')
    .run(userId, title, body || null, link || null);
}

// Crea la misma notificación para todos los clientes responsables (activos) de una empresa
function notifyResponsables(companyId, payload) {
  if (!companyId) return 0;
  const users = db.prepare(
    "SELECT id FROM users WHERE company_id = ? AND role = 'cliente_responsable' AND active = 1"
  ).all(companyId);
  users.forEach((u) => notify(u.id, payload));
  return users.length;
}

// Últimas notificaciones de un usuario
function listFor(userId, limit = 12) {
  return db.prepare(
    'SELECT id, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, limit);
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;
}

function markAllRead(userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}

// Al enviar una minuta/contrato: notifica en la campanita Y por correo a los responsables de la empresa
async function notificarDocumentoEnviado(companyId, { kind, title }) {
  if (!companyId) return 0;
  const { sendDocumentEmail } = require('./mailer');
  const users = db.prepare(
    "SELECT id, display_name, email, company_name FROM users WHERE company_id = ? AND role = 'cliente_responsable' AND active = 1"
  ).all(companyId);
  const esContrato = kind === 'contrato';
  const title2 = esContrato ? 'Nuevo contrato para firmar' : 'Nueva minuta disponible';
  for (const u of users) {
    notify(u.id, { title: title2, body: title, link: '/app/minutas' });
    if (u.email) {
      try { await sendDocumentEmail({ to: u.email, displayName: u.display_name, kind, title, companyName: u.company_name }); }
      catch (_) { /* el envío por correo es best-effort */ }
    }
  }
  return users.length;
}

module.exports = { notify, notifyResponsables, listFor, unreadCount, markAllRead, notificarDocumentoEnviado };
