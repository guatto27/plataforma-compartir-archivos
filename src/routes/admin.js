'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('../config');
const { db, logAction } = require('../db');
const { upload } = require('../lib/upload');
const { makeFileRouter } = require('./files');
const { makeInterviewActionsRouter, getAccessibleInterview } = require('./interviews');
const {
  requireLogin,
  requireRole,
  requirePasswordChanged,
  verifyCsrf,
  denyCsrf,
} = require('../middleware/auth');

const router = express.Router();

router.use(requireLogin, requireRole('admin'), requirePasswordChanged);

// Acciones por archivo y por entrevista
router.use(makeFileRouter());
router.use(makeInterviewActionsRouter());

// Genera una contraseña temporal legible
function tempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '7x';
}

function activeClients() {
  return db
    .prepare(`SELECT id, username, display_name, company_name FROM users WHERE role = 'client' AND active = 1 ORDER BY display_name`)
    .all();
}

// Página principal: Entrevistas (todos los clientes)
router.get('/', (req, res) => {
  const interviews = db
    .prepare(
      `SELECT iv.*,
              cl.username AS client_username, cl.display_name AS client_name,
              (SELECT COUNT(*) FROM files f WHERE f.interview_id = iv.id) AS file_count
       FROM interviews iv
       LEFT JOIN users cl ON cl.id = iv.client_id
       ORDER BY iv.created_at DESC`
    )
    .all();

  res.render('admin/interviews', { title: 'Entrevistas', interviews, clients: activeClients() });
});

// Crear una entrevista (admin elige el cliente)
router.post('/interviews', (req, res) => {
  const client = db
    .prepare(`SELECT * FROM users WHERE id = ? AND role = 'client' AND active = 1`)
    .get(req.body.client_id);
  if (!client) {
    req.session.flash = { type: 'error', text: 'Selecciona un cliente válido para la entrevista.' };
    return res.redirect('/admin');
  }
  const nombre = String(req.body.nombre || '').trim().slice(0, 160);
  const cargo = String(req.body.cargo || '').trim().slice(0, 160);
  const area = String(req.body.area || '').trim().slice(0, 160);
  if (!nombre) {
    req.session.flash = { type: 'error', text: 'El nombre de la persona entrevistada es obligatorio.' };
    return res.redirect('/admin');
  }
  db.prepare(
    `INSERT INTO interviews (client_id, created_by, nombre, cargo, area) VALUES (?, ?, ?, ?, ?)`
  ).run(client.id, req.session.userId, nombre, cargo, area);
  logAction(req.session.userId, 'interview_create', `${nombre} (${client.username})`, req.ip);

  req.session.flash = { type: 'success', text: 'Entrevista agregada.' };
  res.redirect('/admin');
});

// Página de Archivos (todos los espacios; opcionalmente filtrada por entrevista)
router.get('/archivos', (req, res) => {
  let interview = null;
  if (req.query.entrevista) {
    interview = getAccessibleInterview(req, req.query.entrevista) || null;
  }

  const params = [];
  let where = '1 = 1';
  if (interview) {
    where = 'f.interview_id = ?';
    params.push(interview.id);
  }

  const files = db
    .prepare(
      `SELECT f.*,
              u.username AS owner_username, u.display_name AS owner_name, u.role AS owner_role,
              cl.username AS client_username, cl.display_name AS client_name,
              iv.nombre AS interview_nombre,
              (SELECT COUNT(*) FROM comments c WHERE c.file_id = f.id) AS comment_count
       FROM files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN users cl ON cl.id = f.client_id
       LEFT JOIN interviews iv ON iv.id = f.interview_id
       WHERE ${where}
       ORDER BY f.created_at DESC`
    )
    .all(...params);

  // Entrevistas para el desplegable (etiquetadas con su cliente)
  const interviews = db
    .prepare(
      `SELECT iv.id, iv.nombre, iv.cargo, iv.client_id, cl.display_name AS client_name, cl.username AS client_username
       FROM interviews iv LEFT JOIN users cl ON cl.id = iv.client_id
       ORDER BY cl.display_name, iv.nombre`
    )
    .all();

  res.render('files', {
    title: 'Archivos',
    files,
    interviews,
    interview,
    clients: activeClients(),
    maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
  });
});

// Subir archivo(s): si se elige entrevista, el cliente se deriva de ella
router.post('/upload', upload.array('files', 10), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);

  let interviewId = null;
  let client = null;

  if (req.body.interview_id) {
    const iv = getAccessibleInterview(req, req.body.interview_id);
    if (iv) {
      interviewId = iv.id;
      client = db.prepare(`SELECT * FROM users WHERE id = ?`).get(iv.client_id);
    }
  }
  if (!client) {
    client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client' AND active = 1`).get(req.body.client_id);
  }

  const redirectTo = interviewId ? `/admin/archivos?entrevista=${interviewId}` : '/admin/archivos';

  if (!client) {
    req.session.flash = { type: 'error', text: 'Selecciona un cliente válido para los archivos.' };
    return res.redirect(redirectTo);
  }

  const files = req.files || [];
  if (files.length === 0) {
    req.session.flash = { type: 'error', text: 'No seleccionaste ningún archivo.' };
    return res.redirect(redirectTo);
  }

  const description = String(req.body.description || '').slice(0, 500);
  const insert = db.prepare(
    `INSERT INTO files (client_id, uploaded_by, direction, interview_id, stored_name, original_name, mime, size, description)
     VALUES (?, ?, 'to_client', ?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insert.run(client.id, req.session.userId, interviewId, f.filename, f.originalname, f.mimetype, f.size, description);
  }
  logAction(req.session.userId, 'admin_share', `${files.length} archivo(s) -> ${client.username}`, req.ip);

  req.session.flash = { type: 'success', text: `Archivo(s) compartido(s) con ${client.display_name || client.username}.` };
  res.redirect(redirectTo);
});

// ---------- Gestión (oculta del menú principal): clientes + auditoría ----------
router.get('/gestion', (req, res) => {
  const clients = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM files f WHERE f.client_id = u.id AND f.direction = 'to_admin') AS files_in,
              (SELECT COUNT(*) FROM files f WHERE f.client_id = u.id AND f.direction = 'to_client') AS files_out,
              (SELECT COUNT(*) FROM interviews iv WHERE iv.client_id = u.id) AS links
       FROM users u WHERE u.role = 'client' ORDER BY u.created_at DESC`
    )
    .all();

  const summary = {
    total: clients.length,
    withInterview: clients.filter((c) => c.links > 0).length,
    withUploads: clients.filter((c) => c.files_in > 0).length,
  };
  summary.pending = clients.filter((c) => c.active && (c.links === 0 || c.files_in === 0)).length;

  // Capturamos y BORRAMOS antes de render: así la sesión se guarda sin las
  // credenciales y solo se muestran una vez (mostrarlas siempre sería un riesgo).
  const newCredentials = req.session.newCredentials || null;
  delete req.session.newCredentials;

  res.render('admin/gestion', {
    title: 'Clientes',
    clients,
    summary,
    newCredentials,
  });
});

// Crear un nuevo cliente con credenciales
router.post('/clients', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.display_name || '').trim().slice(0, 120);
  const company = String(req.body.company_name || '').trim().slice(0, 120);
  let password = String(req.body.password || '').trim();

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    req.session.flash = {
      type: 'error',
      text: 'Usuario inválido. Usa 3-40 caracteres: letras, números, punto, guion o guion bajo.',
    };
    return res.redirect('/admin/gestion');
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    req.session.flash = { type: 'error', text: 'Ese usuario ya existe.' };
    return res.redirect('/admin/gestion');
  }

  if (!password) password = tempPassword();
  if (password.length < 10) {
    req.session.flash = { type: 'error', text: 'La contraseña temporal debe tener al menos 10 caracteres.' };
    return res.redirect('/admin/gestion');
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, company_name, must_change_password)
     VALUES (?, ?, 'client', ?, ?, 1)`
  ).run(username, hash, displayName || username, company);
  logAction(req.session.userId, 'create_client', username, req.ip);

  req.session.newCredentials = { username, password };
  req.session.flash = { type: 'success', text: 'Cliente creado. Copia y comparte las credenciales de forma segura.' };
  res.redirect('/admin/gestion');
});

// Detalle de un cliente
router.get('/clients/:id', (req, res) => {
  const client = db
    .prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`)
    .get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Cliente no encontrado.' });
  }

  const filesFromClient = db
    .prepare(`SELECT * FROM files WHERE client_id = ? AND direction = 'to_admin' ORDER BY created_at DESC`)
    .all(client.id);
  const filesToClient = db
    .prepare(`SELECT * FROM files WHERE client_id = ? AND direction = 'to_client' ORDER BY created_at DESC`)
    .all(client.id);
  const interviews = db
    .prepare(`SELECT * FROM interviews WHERE client_id = ? ORDER BY created_at DESC`)
    .all(client.id);

  res.render('admin/client', {
    title: client.display_name || client.username,
    cliente: client, // "client" es una opción reservada de EJS; no usar como local
    filesFromClient,
    filesToClient,
    interviews,
    allowedExt: config.allowedExt,
    maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
  });
});

// Compartir archivo(s) con el cliente desde su ficha
router.post('/clients/:id/upload', upload.array('files', 10), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);

  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Cliente no encontrado.' });
  }

  const files = req.files || [];
  if (files.length === 0) {
    req.session.flash = { type: 'error', text: 'No seleccionaste ningún archivo.' };
    return res.redirect(`/admin/clients/${client.id}`);
  }

  const description = String(req.body.description || '').slice(0, 500);
  const insert = db.prepare(
    `INSERT INTO files (client_id, uploaded_by, direction, stored_name, original_name, mime, size, description)
     VALUES (?, ?, 'to_client', ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insert.run(client.id, req.session.userId, f.filename, f.originalname, f.mimetype, f.size, description);
  }
  logAction(req.session.userId, 'admin_share', `${files.length} archivo(s) -> ${client.username}`, req.ip);

  req.session.flash = { type: 'success', text: 'Archivo(s) compartido(s) con el cliente.' };
  res.redirect(`/admin/clients/${client.id}`);
});

// Editar la información de un cliente (nombre de contacto, empresa, usuario)
router.post('/clients/:id/edit', (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Cliente no encontrado.' });
  }

  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.display_name || '').trim().slice(0, 120);
  const company = String(req.body.company_name || '').trim().slice(0, 120);
  const back = `/admin/clients/${client.id}`;

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    req.session.flash = {
      type: 'error',
      text: 'Usuario inválido. Usa 3-40 caracteres: letras, números, punto, guion o guion bajo.',
    };
    return res.redirect(back);
  }
  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, client.id);
  if (taken) {
    req.session.flash = { type: 'error', text: 'Ese usuario ya está en uso por otra cuenta.' };
    return res.redirect(back);
  }

  db.prepare('UPDATE users SET username = ?, display_name = ?, company_name = ? WHERE id = ?').run(
    username,
    displayName || username,
    company,
    client.id
  );
  logAction(req.session.userId, 'edit_client', `${client.username} -> ${username}`, req.ip);
  req.session.flash = { type: 'success', text: 'Información del cliente actualizada.' };
  res.redirect(back);
});

// Restablecer contraseña de un cliente
router.post('/clients/:id/reset-password', (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Cliente no encontrado.' });
  }
  const password = tempPassword();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, client.id);
  logAction(req.session.userId, 'reset_password', client.username, req.ip);

  req.session.newCredentials = { username: client.username, password };
  req.session.flash = { type: 'success', text: 'Contraseña restablecida. Comparte la nueva de forma segura.' };
  res.redirect('/admin/gestion');
});

// Activar / desactivar acceso de un cliente
router.post('/clients/:id/toggle-active', (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Cliente no encontrado.' });
  }
  const next = client.active ? 0 : 1;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(next, client.id);
  logAction(req.session.userId, next ? 'enable_client' : 'disable_client', client.username, req.ip);
  req.session.flash = { type: 'success', text: next ? 'Cliente activado.' : 'Cliente desactivado.' };
  res.redirect('/admin/gestion');
});

// Eliminar un cliente por completo (sus entrevistas, archivos y comentarios)
router.post('/clients/:id/delete', (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Cliente no encontrado.' });
  }

  // Borra primero los archivos físicos (la BD elimina las filas en cascada)
  const files = db.prepare('SELECT stored_name FROM files WHERE client_id = ?').all(client.id);
  for (const f of files) {
    const abs = path.join(config.uploadsDir, f.stored_name);
    if (abs.startsWith(config.uploadsDir)) fs.unlink(abs, () => {});
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(client.id);
  logAction(req.session.userId, 'delete_client', client.username, req.ip);

  req.session.flash = { type: 'success', text: `Cliente "${client.display_name || client.username}" eliminado.` };
  res.redirect('/admin/gestion');
});

module.exports = router;
