'use strict';

const crypto = require('crypto');

// Requiere sesión iniciada
function requireLogin(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

// Requiere un rol concreto
function requireRole(role) {
  return function (req, res, next) {
    if (req.session && req.session.userId && req.session.role === role) return next();
    return res.status(403).render('error', {
      title: 'Acceso denegado',
      message: 'No tienes permiso para ver esta página.',
    });
  };
}

// Requiere personal interno: administrador o colaborador (acceso al área /admin)
function requireStaff(req, res, next) {
  if (req.session && req.session.userId && (req.session.role === 'admin' || req.session.role === 'colaborador')) {
    return next();
  }
  return res.status(403).render('error', {
    title: 'Acceso denegado',
    message: 'No tienes permiso para ver esta página.',
  });
}

// Requiere usuario de empresa cliente: 'client' (usuario) o 'cliente_responsable'
function requireClientArea(req, res, next) {
  if (req.session && req.session.userId && (req.session.role === 'client' || req.session.role === 'cliente_responsable')) {
    return next();
  }
  return res.status(403).render('error', {
    title: 'Acceso denegado',
    message: 'No tienes permiso para ver esta página.',
  });
}

// Si el usuario debe cambiar su contraseña, lo forzamos antes de seguir
function requirePasswordChanged(req, res, next) {
  if (req.session && req.session.mustChangePassword) {
    if (req.path === '/cambiar-password' || req.path === '/logout') return next();
    return res.redirect('/cambiar-password');
  }
  return next();
}

// --- CSRF (patrón de token sincronizador por sesión) ---
function csrfToken(req) {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfSecret;
}

// Valida el token CSRF a partir de lo ya parseado en req.body / cabeceras.
// Devuelve true/false (no responde). Útil tras multer en formularios multipart.
function verifyCsrf(req) {
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const secret = req.session.csrfSecret || '';
  return (
    sent.length > 0 &&
    secret.length > 0 &&
    sent.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret))
  );
}

function denyCsrf(res) {
  return res.status(403).render('error', {
    title: 'Sesión inválida',
    message: 'Token de seguridad inválido o caducado. Recarga la página e inténtalo de nuevo.',
  });
}

function csrfProtection(req, res, next) {
  // Expone el token a las vistas
  res.locals.csrfToken = csrfToken(req);

  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();

  // Las peticiones multipart (subida de archivos) se validan en la ruta,
  // DESPUÉS de que multer parsee el cuerpo (donde estará _csrf).
  const ct = req.get('content-type') || '';
  if (ct.startsWith('multipart/form-data')) return next();

  if (verifyCsrf(req)) return next();
  return denyCsrf(res);
}

module.exports = {
  requireLogin,
  requireRole,
  requireStaff,
  requireClientArea,
  requirePasswordChanged,
  csrfProtection,
  verifyCsrf,
  denyCsrf,
};
