'use strict';

const express = require('express');

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

// Todas las rutas requieren cliente autenticado con contraseña ya cambiada
router.use(requireLogin, requireRole('client'), requirePasswordChanged);

// Acciones por archivo y por entrevista (ver, descargar, eliminar, comentar, link)
router.use(makeFileRouter());
router.use(makeInterviewActionsRouter());

// Página principal: Entrevistas
router.get('/', (req, res) => {
  const interviews = db
    .prepare(
      `SELECT iv.*,
              (SELECT COUNT(*) FROM files f WHERE f.interview_id = iv.id) AS file_count
       FROM interviews iv
       WHERE iv.client_id = ?
       ORDER BY iv.created_at DESC`
    )
    .all(req.session.userId);

  res.render('client/interviews', { title: 'Entrevistas', interviews });
});

// Nota: el usuario (cliente) NO crea entrevistas; las registra el equipo
// (admin/colaborador). El usuario solo pega el link y asocia archivos.

// Página de Archivos (opcionalmente filtrada por entrevista)
router.get('/archivos', (req, res) => {
  const clientId = req.session.userId;

  let interview = null;
  if (req.query.entrevista) {
    const iv = getAccessibleInterview(req, req.query.entrevista);
    if (iv && iv.client_id === clientId) interview = iv;
  }

  const params = [clientId];
  let where = 'f.client_id = ?';
  if (interview) {
    where += ' AND f.interview_id = ?';
    params.push(interview.id);
  }

  const files = db
    .prepare(
      `SELECT f.*,
              u.username AS owner_username, u.display_name AS owner_name, u.role AS owner_role,
              iv.nombre AS interview_nombre,
              (SELECT COUNT(*) FROM comments c WHERE c.file_id = f.id) AS comment_count
       FROM files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN interviews iv ON iv.id = f.interview_id
       WHERE ${where}
       ORDER BY f.created_at DESC`
    )
    .all(...params);

  const interviews = db
    .prepare(`SELECT id, nombre, cargo FROM interviews WHERE client_id = ? ORDER BY nombre`)
    .all(clientId);

  res.render('files', {
    title: 'Archivos',
    files,
    interviews,
    interview,
    clients: null, // cliente no elige cliente destino
    maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
  });
});

// Subida de archivos del cliente hacia el consultor
router.post('/upload', upload.array('files', 10), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);

  const files = req.files || [];
  let interviewId = null;
  if (req.body.interview_id) {
    const iv = getAccessibleInterview(req, req.body.interview_id);
    if (iv && iv.client_id === req.session.userId) interviewId = iv.id;
  }

  if (files.length === 0) {
    req.session.flash = { type: 'error', text: 'No seleccionaste ningún archivo.' };
    return res.redirect(interviewId ? `/app/archivos?entrevista=${interviewId}` : '/app/archivos');
  }

  const description = String(req.body.description || '').slice(0, 500);
  const insert = db.prepare(
    `INSERT INTO files (client_id, uploaded_by, direction, interview_id, stored_name, original_name, mime, size, description)
     VALUES (?, ?, 'to_admin', ?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insert.run(req.session.userId, req.session.userId, interviewId, f.filename, f.originalname, f.mimetype, f.size, description);
  }
  logAction(req.session.userId, 'client_upload', `${files.length} archivo(s)`, req.ip);

  req.session.flash = { type: 'success', text: 'Archivo(s) subido(s) correctamente.' };
  res.redirect(interviewId ? `/app/archivos?entrevista=${interviewId}` : '/app/archivos');
});

module.exports = router;
