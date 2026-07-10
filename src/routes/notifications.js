'use strict';

const express = require('express');
const { db } = require('../db');
const { requireLogin, verifyCsrf, denyCsrf } = require('../middleware/auth');
const notifLib = require('../lib/notifications');

const router = express.Router();
router.use(requireLogin);

// Marcar todas como leídas
router.post('/leer', (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  notifLib.markAllRead(req.session.userId);
  res.redirect(req.get('Referer') || '/');
});

// Abrir una notificación: la marca leída y redirige a su enlace
router.get('/ir/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (n) db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id);
  res.redirect((n && n.link) || '/');
});

module.exports = router;
