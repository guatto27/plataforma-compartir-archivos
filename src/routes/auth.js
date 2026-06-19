'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { db, logAction } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../lib/mailer');
const config = require('../config');

const router = express.Router();

// Limita intentos de login para frenar ataques de fuerza bruta
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10, // 10 intentos por ventana por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: undefined,
  handler: (req, res) => {
    res.status(429).render('login', {
      title: 'Iniciar sesión',
      error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    });
  },
});

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Iniciar sesión', error: null });
});

router.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const fail = () =>
    res.status(401).render('login', {
      title: 'Iniciar sesión',
      error: 'Usuario o contraseña incorrectos.',
    });

  if (!username || !password) return fail();

  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(username);

  // Comparación con hash incluso si no existe el usuario, para no filtrar tiempos
  const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = bcrypt.compareSync(password, hash);

  if (!user || !ok) {
    logAction(user ? user.id : null, 'login_failed', username, req.ip);
    return fail();
  }

  // Regenera la sesión para evitar fijación de sesión
  req.session.regenerate((err) => {
    if (err) return fail();
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.displayName = user.display_name || user.username;
    req.session.mustChangePassword = !!user.must_change_password;
    logAction(user.id, 'login_ok', null, req.ip);
    res.redirect('/');
  });
});

router.post('/logout', requireLogin, (req, res) => {
  const uid = req.session.userId;
  req.session.destroy(() => {
    logAction(uid, 'logout', null, req.ip);
    res.clearCookie('bc.sid');
    res.redirect('/login');
  });
});

// --- Cambio de contraseña (obligatorio en el primer acceso) ---
router.get('/cambiar-password', requireLogin, (req, res) => {
  res.render('change-password', {
    title: 'Cambiar contraseña',
    error: null,
    forced: !!req.session.mustChangePassword,
  });
});

router.post('/cambiar-password', requireLogin, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const confirm = String(req.body.confirm || '');

  const render = (error) =>
    res.status(400).render('change-password', {
      title: 'Cambiar contraseña',
      error,
      forced: !!req.session.mustChangePassword,
    });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.redirect('/login');

  if (!bcrypt.compareSync(current, user.password_hash)) {
    return render('La contraseña actual no es correcta.');
  }
  if (next.length < 10) {
    return render('La nueva contraseña debe tener al menos 10 caracteres.');
  }
  if (next !== confirm) {
    return render('La confirmación no coincide.');
  }
  if (bcrypt.compareSync(next, user.password_hash)) {
    return render('La nueva contraseña debe ser distinta a la actual.');
  }

  const hash = bcrypt.hashSync(next, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
    hash,
    user.id
  );
  req.session.mustChangePassword = false;
  logAction(user.id, 'password_changed', null, req.ip);

  req.session.flash = { type: 'success', text: 'Contraseña actualizada correctamente.' };
  res.redirect('/');
});

// --- Recuperación de contraseña ---
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('forgot-password', {
    title: 'Recuperar contraseña', error: 'Demasiados intentos. Espera unos minutos.',
  }),
});

router.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('forgot-password', { title: 'Recuperar contraseña', error: null });
});

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const render = (error) => res.render('forgot-password', { title: 'Recuperar contraseña', error });

  if (!email) return render('Ingresa tu correo electrónico.');

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ? AND active = 1').get(email);

  // Siempre mostramos éxito para no revelar si el correo existe
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expires);
    const resetUrl = `${config.appUrl}/reset-password/${token}`;
    await sendPasswordResetEmail({ to: user.email, displayName: user.display_name, resetUrl });
    logAction(user.id, 'password_reset_requested', null, req.ip);
  }

  res.render('forgot-password', { title: 'Recuperar contraseña', success: true });
});

router.get('/reset-password/:token', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const row = db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0'
  ).get(req.params.token);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.render('reset-password', { title: 'Nueva contraseña', expired: true, token: null });
  }
  res.render('reset-password', { title: 'Nueva contraseña', token: req.params.token, error: null });
});

router.post('/reset-password/:token', async (req, res) => {
  const row = db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0'
  ).get(req.params.token);

  if (!row || new Date(row.expires_at) < new Date()) {
    return res.render('reset-password', { title: 'Nueva contraseña', expired: true, token: null });
  }

  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const render = (error) => res.render('reset-password', {
    title: 'Nueva contraseña', token: req.params.token, error,
  });

  if (password.length < 10) return render('La contraseña debe tener al menos 10 caracteres.');
  if (password !== confirm) return render('Las contraseñas no coinciden.');

  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);
  logAction(row.user_id, 'password_reset_completed', null, req.ip);

  res.render('reset-password', { title: 'Nueva contraseña', success: true, token: null });
});

module.exports = router;
