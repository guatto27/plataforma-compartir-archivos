'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const config = require('./config');
const { db } = require('./db');
const { csrfProtection } = require('./middleware/auth');

// Asegura carpetas necesarias
fs.mkdirSync(config.uploadsDir, { recursive: true });

const app = express();

// Detrás de un proxy/HTTPS (p. ej. Nginx, Render, Railway) las cookies "secure" funcionan bien
app.set('trust proxy', 1);

// Vistas
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Seguridad de cabeceras
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        // Necesario para previsualizar PDFs con <object>/<embed>/<iframe> del mismo origen
        objectSrc: ["'self'"],
        frameSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

// Parsers
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Archivos estáticos (CSS, etc.) — NUNCA sirve la carpeta de uploads
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// Sesiones
app.use(
  session({
    name: 'bc.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 1000 * 60 * 60 * 4, // 4 horas
    },
  })
);

// Variables disponibles en todas las vistas
app.use((req, res, next) => {
  res.locals.brand = config.brand;
  if (req.session.userId) {
    var u = db.prepare('SELECT display_name, company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
    var companyHasLogo = false;
    if (u && u.company_id) {
      var c = db.prepare('SELECT logo_path FROM companies WHERE id = ?').get(u.company_id);
      companyHasLogo = !!(c && c.logo_path);
    }
    res.locals.currentUser = {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
      displayName: (u && u.display_name) || req.session.displayName || req.session.username,
      companyName: u ? u.company_name : null,
      companyId: u ? u.company_id : null,
      companyHasLogo: companyHasLogo,
    };
  } else {
    res.locals.currentUser = null;
  }
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  // Ayudantes de formato para las vistas
  res.locals.fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  res.locals.fmtDate = (s) => {
    if (!s) return '';
    const [d, t] = String(s).split(' ');
    const [Y, M, D] = d.split('-');
    return `${D}/${M}/${Y} ${(t || '').slice(0, 5)}`;
  };
  // Nombre propio: "JORGE SANCHEZ LEON" -> "Jorge Sanchez Leon" (respeta partículas)
  res.locals.titleCase = (s) => {
    if (!s) return '';
    const minus = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'das', 'dos', 'van', 'von']);
    return String(s).trim().toLowerCase().split(/\s+/).map((w, i) => {
      if (i > 0 && minus.has(w)) return w;
      return w.replace(/^([\wáéíóúñü])/i, (c) => c.toUpperCase());
    }).join(' ');
  };
  next();
});

// Verificación pública (la abre el QR del PDF): de solo lectura, va antes del
// CSRF para permitir la carga del archivo sin token de sesión.
app.use('/verificar', require('./routes/verificar'));

// Protección CSRF (expone csrfToken y valida POST)
app.use(csrfProtection);

// Rutas
app.use('/', require('./routes/auth'));
app.use('/app', require('./routes/client'));
app.use('/admin', require('./routes/admin'));
app.use('/admin/minutas', require('./routes/admin-minutas'));

// Raíz
app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const isStaff = req.session.role === 'admin' || req.session.role === 'colaborador';
  return res.redirect(isStaff ? '/admin' : '/app');
});

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'No encontrado',
    message: 'La página que buscas no existe.',
  });
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error(err);
  const maxMb = Math.round(config.maxFileBytes / (1024 * 1024));
  let message = 'Ocurrió un error inesperado.';
  let status = err.status || 500;

  if (err.code === 'LIMIT_FILE_SIZE') {
    message = `El archivo supera el tamaño máximo permitido (${maxMb} MB).`;
    status = 413;
  } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    message = 'Demasiados archivos en un solo envío (máximo 10).';
    status = 400;
  } else if (typeof err.message === 'string' && err.message.startsWith('Tipo de archivo')) {
    message = err.message;
    status = 400;
  }

  res.status(status).render('error', { title: 'Error', message });
});

const server = app.listen(config.port, () => {
  console.log(`\n  ${config.brand.name} — portal seguro`);
  console.log(`  Escuchando en http://localhost:${config.port}`);
  console.log(`  Entorno: ${config.env}\n`);
});

// Subidas grandes (audio/video): damos margen para que no se corten.
server.requestTimeout = 30 * 60 * 1000; // 30 min por petición
server.headersTimeout = 66 * 1000;
