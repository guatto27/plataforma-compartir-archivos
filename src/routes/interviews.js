'use strict';

const express = require('express');
const { db, logAction } = require('../db');

// Devuelve la entrevista si el usuario actual puede acceder a ella, o null.
function getAccessibleInterview(req, id) {
  const iv = db.prepare('SELECT * FROM interviews WHERE id = ?').get(id);
  if (!iv) return null;
  if (req.session.role === 'admin') return iv;
  if (iv.client_id === req.session.userId) return iv;
  return null;
}

function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// Acciones por entrevista (guardar link, eliminar). Se monta bajo /app y /admin.
function makeInterviewActionsRouter() {
  const router = express.Router({ mergeParams: true });

  // Guardar / actualizar el link de la entrevista (el que da Gemini)
  router.post('/interviews/:id/link', (req, res) => {
    const iv = getAccessibleInterview(req, req.params.id);
    if (!iv) return res.status(404).render('error', { title: 'No encontrado', message: 'Entrevista no encontrada.' });

    const url = String(req.body.url || '').trim();
    if (!isValidHttpUrl(url)) {
      req.session.flash = { type: 'error', text: 'Ingresa un enlace válido (debe empezar con https://).' };
      return res.redirect(req.baseUrl);
    }
    db.prepare('UPDATE interviews SET interview_url = ? WHERE id = ?').run(url, iv.id);
    logAction(req.session.userId, 'interview_link', `${iv.nombre}: ${url}`, req.ip);
    req.session.flash = { type: 'success', text: 'Enlace de la entrevista guardado.' };
    return res.redirect(req.baseUrl);
  });

  // Eliminar una entrevista (los archivos quedan, pero se desvinculan)
  router.post('/interviews/:id/delete', (req, res) => {
    const iv = getAccessibleInterview(req, req.params.id);
    if (!iv) return res.status(404).render('error', { title: 'No encontrado', message: 'Entrevista no encontrada.' });

    db.prepare('UPDATE files SET interview_id = NULL WHERE interview_id = ?').run(iv.id);
    db.prepare('DELETE FROM interviews WHERE id = ?').run(iv.id);
    logAction(req.session.userId, 'interview_delete', iv.nombre, req.ip);
    req.session.flash = { type: 'success', text: 'Entrevista eliminada (sus archivos se conservan sin asociar).' };
    return res.redirect(req.baseUrl);
  });

  return router;
}

module.exports = { makeInterviewActionsRouter, getAccessibleInterview, isValidHttpUrl };
