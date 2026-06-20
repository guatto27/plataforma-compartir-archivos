'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('../config');
const { db, logAction } = require('../db');

// Tipos que se pueden previsualizar de forma segura en el navegador.
// Los demás (incluido SVG, por riesgo de scripts) se descargan.
const INLINE_VIEWABLE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'pdf', 'txt', 'md', 'csv',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac',
]);

// Devuelve el archivo si el usuario actual puede acceder a él, o null.
function getAccessibleFile(req, id) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file) return null;
  if (req.session.role === 'admin') return file;
  if (file.client_id === req.session.userId) return file;
  return null;
}

function absPathOf(file) {
  const abs = path.join(config.uploadsDir, file.stored_name);
  if (!abs.startsWith(config.uploadsDir) || !fs.existsSync(abs)) return null;
  return abs;
}

function notFound(res) {
  return res.status(404).render('error', { title: 'No encontrado', message: 'Archivo no disponible.' });
}

// Router con las acciones por archivo. Se monta bajo /app y /admin,
// por lo que req.baseUrl es '/app' o '/admin' y sirve para los enlaces de vuelta.
function makeFileRouter() {
  const router = express.Router({ mergeParams: true });

  // Previsualizar en el navegador
  router.get('/file/:id/view', (req, res) => {
    const file = getAccessibleFile(req, req.params.id);
    if (!file) return notFound(res);
    const abs = absPathOf(file);
    if (!abs) return notFound(res);

    const ext = path.extname(file.original_name).toLowerCase().replace('.', '');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (INLINE_VIEWABLE.has(ext)) {
      // Sandbox: aunque el archivo intentara ejecutar algo, queda aislado.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
      res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(file.original_name) + '"');
      logAction(req.session.userId, 'file_view', file.original_name, req.ip);
      return res.sendFile(abs);
    }
    // No previsualizable: se descarga
    logAction(req.session.userId, 'file_download', file.original_name, req.ip);
    return res.download(abs, file.original_name);
  });

  // Descargar
  router.get('/file/:id/download', (req, res) => {
    const file = getAccessibleFile(req, req.params.id);
    if (!file) return notFound(res);
    const abs = absPathOf(file);
    if (!abs) return notFound(res);
    logAction(req.session.userId, 'file_download', file.original_name, req.ip);
    return res.download(abs, file.original_name);
  });

  // Eliminar (quien lo subió, o un administrador)
  router.post('/file/:id/delete', (req, res) => {
    const file = getAccessibleFile(req, req.params.id);
    if (!file) return notFound(res);
    const isAdmin = req.session.role === 'admin';
    if (!isAdmin && file.uploaded_by !== req.session.userId) {
      req.session.flash = { type: 'error', text: 'Solo quien subió el archivo (o un administrador) puede eliminarlo.' };
      return res.redirect(req.baseUrl);
    }
    const abs = path.join(config.uploadsDir, file.stored_name);
    if (abs.startsWith(config.uploadsDir)) {
      fs.unlink(abs, () => {});
    }
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id); // comentarios en cascada
    logAction(req.session.userId, 'file_delete', file.original_name, req.ip);
    req.session.flash = { type: 'success', text: 'Archivo eliminado.' };
    return res.redirect(req.baseUrl);
  });

  // Ver / añadir comentarios (cualquiera que pueda ver el archivo)
  router.get('/file/:id/comments', (req, res) => {
    const file = getAccessibleFile(req, req.params.id);
    if (!file) return notFound(res);
    const comments = db
      .prepare(
        `SELECT c.*, u.username, u.display_name, u.role
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.file_id = ? ORDER BY c.id ASC`
      )
      .all(file.id);
    res.render('comments', { title: 'Comentarios', file, comments, backUrl: req.baseUrl });
  });

  router.post('/file/:id/comments', (req, res) => {
    const file = getAccessibleFile(req, req.params.id);
    if (!file) return notFound(res);
    const body = String(req.body.body || '').trim().slice(0, 2000);
    if (body) {
      db.prepare('INSERT INTO comments (file_id, user_id, body) VALUES (?, ?, ?)').run(
        file.id,
        req.session.userId,
        body
      );
      logAction(req.session.userId, 'comment_add', file.original_name, req.ip);
    }
    return res.redirect(`${req.baseUrl}/file/${file.id}/comments`);
  });

  return router;
}

module.exports = { makeFileRouter };
