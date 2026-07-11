'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const multer = require('multer');
const config = require('../config');
const { db, logAction } = require('../db');
const { upload } = require('../lib/upload');
const { makeFileRouter } = require('./files');
const { makeInterviewActionsRouter, getAccessibleInterview } = require('./interviews');
const { sendWelcomeEmail } = require('../lib/mailer');
const { removeLogoBackground } = require('../lib/logo-bg');
const projectsLib = require('../lib/projects');
const { firmarContrato, CONTRATOS_DIR } = require('../lib/minuta-firma');
const { notificarDocumentoEnviado } = require('../lib/notifications');

// Subida del contrato (PDF) a disco y de .key/.cer en memoria (nunca se guardan)
const contratoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CONTRATOS_DIR),
    filename: (req, file, cb) => cb(null, `contrato-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.pdf`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.pdf'),
});
const memUploadFirma = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const {
  requireLogin,
  requireRole,
  requireStaff,
  requirePasswordChanged,
  verifyCsrf,
  denyCsrf,
} = require('../middleware/auth');

const router = express.Router();

// Acceso al área de equipo: administrador o colaborador.
router.use(requireLogin, requireStaff, requirePasswordChanged);

// Gestión de cuentas (crear/editar/eliminar empresas y usuarios): SOLO admin.
const requireAdmin = requireRole('admin');

// Acciones por archivo y por entrevista
router.use(makeFileRouter());
router.use(makeInterviewActionsRouter());

// Genera una contraseña temporal legible
function tempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '7x';
}

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

// Usuarios (rol "usuario") activos, con el nombre de su empresa — para los desplegables
function activeClients() {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.company_id, c.name AS company_name
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.role IN ('client', 'cliente_responsable') AND u.active = 1
       ORDER BY c.name, u.display_name`
    )
    .all();
}

function activeCompanies() {
  return db.prepare(`SELECT id, name FROM companies WHERE active = 1 ORDER BY name`).all();
}

// Proyecto en foco para filtrar las páginas del admin (?proyecto=ID)
function adminProjectFilter(req) {
  const id = parseInt(req.query.proyecto, 10) || null;
  if (!id) return null;
  return db.prepare(
    'SELECT p.id, p.name, c.name AS company_name FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.id = ?'
  ).get(id) || null;
}

// Selecciona el proyecto activo del admin (lo guarda en sesión y entra a sus entrevistas)
router.get('/seleccionar', (req, res) => {
  const id = parseInt(req.query.id, 10) || null;
  req.session.adminProjectId = (id && db.prepare('SELECT id FROM projects WHERE id = ?').get(id)) ? id : null;
  if (req.session.adminProjectId) return res.redirect('/admin?proyecto=' + req.session.adminProjectId);
  return res.redirect('/admin');
});

// Página principal: Entrevistas (de todos los usuarios, o de un proyecto)
router.get('/', (req, res) => {
  const proj = adminProjectFilter(req);
  const base = `SELECT iv.*,
              cl.username AS client_username, cl.display_name AS client_name,
              (SELECT COUNT(*) FROM files f WHERE f.interview_id = iv.id) AS file_count
       FROM interviews iv
       LEFT JOIN users cl ON cl.id = iv.client_id`;
  const interviews = proj
    ? db.prepare(`${base} WHERE iv.project_id = ? ORDER BY iv.created_at DESC`).all(proj.id)
    : db.prepare(`${base} ORDER BY iv.created_at DESC`).all();

  res.render('admin/interviews', {
    title: 'Entrevistas', active: 'entrevistas', interviews, clients: activeClients(), projectFilter: proj,
    openNew: !!req.query.nuevo,
  });
});

// ───────── Menú superior del admin: Inicio · ¿Quiénes somos? · Proyectos ─────────

// Inicio: panel de administración (métricas + estado + actividad reciente)
router.get('/inicio', (req, res) => {
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const stats = {
    empresas: n('SELECT COUNT(*) AS n FROM companies'),
    proyectos: n('SELECT COUNT(*) AS n FROM projects'),
    minutas: n('SELECT COUNT(*) AS n FROM minutas WHERE publicada = 1'),
    usuarios: n("SELECT COUNT(*) AS n FROM users WHERE role IN ('client','cliente_responsable')"),
    entrevistas: n('SELECT COUNT(*) AS n FROM interviews'),
    archivos: n('SELECT COUNT(*) AS n FROM files'),
  };
  const byStatus = { Vigente: 0, 'En pausa': 0, Finalizado: 0 };
  db.prepare('SELECT status, COUNT(*) AS n FROM projects GROUP BY status').all().forEach((r) => {
    if (byStatus[r.status] !== undefined) byStatus[r.status] = r.n;
  });
  const recentMinutas = db.prepare(
    `SELECT id, titulo, fecha, company_name, firmada, firmada_cliente, publicada
     FROM minutas ORDER BY created_at DESC LIMIT 5`
  ).all();
  const recentCompanies = db.prepare(
    `SELECT c.id, c.name, c.created_at,
            (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id) AS project_count,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role IN ('client','cliente_responsable')) AS user_count
     FROM companies c ORDER BY c.created_at DESC LIMIT 5`
  ).all();
  res.render('admin/inicio', {
    title: 'Panel de Administración', active: 'inicio', stats, byStatus, recentMinutas, recentCompanies,
  });
});

// Proyectos: todos los proyectos de todas las empresas, con su avance
router.get('/proyectos', (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, c.name AS company_name
     FROM projects p JOIN companies c ON c.id = p.company_id
     ORDER BY c.name, p.created_at, p.id`
  ).all().map((p) => {
    const cnt = projectsLib.counts(p.id);
    const ph = projectsLib.phaseProgress(p.id);
    return { id: p.id, name: p.name, status: p.status, company: p.company_name,
             files: cnt.files, minutas: cnt.minutas, interviews: cnt.interviews,
             contrato_path: p.contrato_path, contrato_nombre: p.contrato_nombre,
             contrato_enviado: p.contrato_enviado,
             cont_firmada: p.cont_firmada, cont_firmada_cliente: p.cont_firmada_cliente,
             cont_firma_nombre: p.cont_firma_nombre, cont_fc_nombre: p.cont_fc_nombre,
             fase2_pct: p.fase2_pct, fase3_pct: p.fase3_pct, fase4_pct: p.fase4_pct, phases: ph };
  });
  res.render('admin/proyectos', {
    title: 'Proyectos', active: 'proyectos', rows,
    companies: activeCompanies(), PROJ_STATUSES,
    canManage: req.session.role === 'admin',
    openNew: !!req.query.nuevo,
  });
});

// Crear una entrevista (admin elige el usuario)
router.post('/interviews', (req, res) => {
  const client = db
    .prepare(`SELECT * FROM users WHERE id = ? AND role = 'client' AND active = 1`)
    .get(req.body.client_id);
  if (!client) {
    req.session.flash = { type: 'error', text: 'Selecciona un usuario válido para la entrevista.' };
    return res.redirect('/admin');
  }
  const nombre = String(req.body.nombre || '').trim().slice(0, 160);
  const cargo = String(req.body.cargo || '').trim().slice(0, 160);
  const area = String(req.body.area || '').trim().slice(0, 160);
  if (!nombre) {
    req.session.flash = { type: 'error', text: 'El nombre de la persona entrevistada es obligatorio.' };
    return res.redirect('/admin');
  }
  // Multi-proyecto: asigna la entrevista al proyecto indicado, o al primer proyecto de la empresa
  let projectId = parseInt(req.body.project_id, 10) || null;
  if (projectId) {
    const ok = db.prepare('SELECT id FROM projects WHERE id = ? AND company_id = ?').get(projectId, client.company_id);
    if (!ok) projectId = null;
  }
  if (!projectId && client.company_id) {
    const p = db.prepare('SELECT id FROM projects WHERE company_id = ? ORDER BY created_at, id LIMIT 1').get(client.company_id);
    projectId = p ? p.id : null;
  }
  db.prepare(
    `INSERT INTO interviews (client_id, created_by, nombre, cargo, area, project_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(client.id, req.session.userId, nombre, cargo, area, projectId);
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

  const proj = adminProjectFilter(req);
  const params = [];
  let where = '1 = 1';
  if (interview) {
    where = 'f.interview_id = ?';
    params.push(interview.id);
  } else if (proj) {
    where = 'f.interview_id IN (SELECT id FROM interviews WHERE project_id = ?)';
    params.push(proj.id);
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

  const interviews = db
    .prepare(
      `SELECT iv.id, iv.nombre, iv.cargo, iv.client_id, cl.display_name AS client_name, cl.username AS client_username
       FROM interviews iv LEFT JOIN users cl ON cl.id = iv.client_id
       ORDER BY cl.display_name, iv.nombre`
    )
    .all();

  res.render('files', {
    title: 'Archivos',
    active: 'archivos',
    files,
    interviews,
    interview,
    projectFilter: proj,
    clients: activeClients(),
    maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
  });
});

// Subir archivo(s): si se elige entrevista, el usuario se deriva de ella
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
    req.session.flash = { type: 'error', text: 'Selecciona un usuario válido para los archivos.' };
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

// ============================ EMPRESAS ============================
// Subida del logo de la empresa (imágenes; se guardan en uploads/logos)
const LOGOS_DIR = path.join(config.uploadsDir, 'logos');
fs.mkdirSync(LOGOS_DIR, { recursive: true });
const LOGO_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'];
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGOS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, LOGO_EXT.includes(path.extname(file.originalname).toLowerCase())),
}).fields([{ name: 'logo', maxCount: 1 }, { name: 'eslogan_img', maxCount: 1 }]);

// Procesa un archivo subido (quita el fondo) y devuelve su nombre, o null.
async function processCompanyImage(file) {
  if (!file) return null;
  try { return path.basename(await removeLogoBackground(file.path)); }
  catch (_) { return file.filename; }
}

// Sirve el logo o el eslogan (imagen) de una empresa (área de equipo)
function serveCompanyImage(col) {
  return (req, res) => {
    const c = db.prepare(`SELECT ${col} AS p FROM companies WHERE id = ?`).get(req.params.id);
    if (!c || !c.p) return res.status(404).send('Sin imagen');
    const filePath = path.join(LOGOS_DIR, c.p);
    if (!fs.existsSync(filePath)) return res.status(404).send('No encontrado');
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.sendFile(filePath);
  };
}
router.get('/empresas/:id/logo', serveCompanyImage('logo_path'));
router.get('/empresas/:id/eslogan', serveCompanyImage('eslogan_path'));

router.get('/empresas', (req, res) => {
  const companies = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role IN ('client', 'cliente_responsable')) AS user_count,
              (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id) AS project_count
       FROM companies c ORDER BY c.created_at DESC`
    )
    .all();
  // Proyectos por empresa (para el gestor en el modal de edición)
  const projByCompany = {};
  db.prepare('SELECT id, company_id, name, status FROM projects ORDER BY created_at, id').all().forEach((p) => {
    (projByCompany[p.company_id] = projByCompany[p.company_id] || []).push(p);
  });
  res.render('admin/empresas', {
    title: 'Empresas', active: 'empresas', companies, projByCompany,
    canManage: req.session.role === 'admin',
    openNew: !!req.query.nuevo,
  });
});

router.post('/empresas', requireAdmin, logoUpload, async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  const esloFile = req.files && req.files.eslogan_img && req.files.eslogan_img[0];
  const name = String(req.body.name || '').trim().slice(0, 160);
  const contact = String(req.body.contact || '').trim().slice(0, 160);
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  if (!name) {
    if (logoFile) fs.unlink(logoFile.path, () => {});
    if (esloFile) fs.unlink(esloFile.path, () => {});
    req.session.flash = { type: 'error', text: 'El nombre de la empresa es obligatorio.' };
    return res.redirect('/admin/empresas');
  }
  const project = String(req.body.project || '').trim().slice(0, 160);
  const eslogan = String(req.body.eslogan || '').trim().slice(0, 160);
  const PROJECT_STATUSES = ['Vigente', 'En pausa', 'Finalizado'];
  const projectStatus = PROJECT_STATUSES.includes(req.body.project_status) ? req.body.project_status : 'Vigente';
  const logoPath = await processCompanyImage(logoFile);
  const esloPath = await processCompanyImage(esloFile);
  const info = db.prepare(`INSERT INTO companies (name, contact, notes, project, eslogan, project_status, logo_path, eslogan_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, contact, notes, project, eslogan, projectStatus, logoPath, esloPath);
  // Multi-proyecto: el proyecto indicado al crear la empresa se registra como su primer proyecto
  if (project) {
    db.prepare('INSERT INTO projects (company_id, name, status) VALUES (?, ?, ?)').run(info.lastInsertRowid, project, projectStatus);
  }
  logAction(req.session.userId, 'company_create', name, req.ip);
  req.session.flash = { type: 'success', text: 'Empresa registrada.' };
  res.redirect('/admin/empresas');
});

router.post('/empresas/:id/edit', requireAdmin, logoUpload, async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  const esloFile = req.files && req.files.eslogan_img && req.files.eslogan_img[0];
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!company) {
    if (logoFile) fs.unlink(logoFile.path, () => {});
    if (esloFile) fs.unlink(esloFile.path, () => {});
    return res.status(404).render('error', { title: 'No encontrado', message: 'Empresa no encontrada.' });
  }
  const name = String(req.body.name || '').trim().slice(0, 160);
  const contact = String(req.body.contact || '').trim().slice(0, 160);
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  if (!name) {
    if (logoFile) fs.unlink(logoFile.path, () => {});
    if (esloFile) fs.unlink(esloFile.path, () => {});
    req.session.flash = { type: 'error', text: 'El nombre de la empresa es obligatorio.' };
    return res.redirect('/admin/empresas');
  }
  const project = String(req.body.project || '').trim().slice(0, 160);
  const eslogan = String(req.body.eslogan || '').trim().slice(0, 160);
  const PROJECT_STATUSES = ['Vigente', 'En pausa', 'Finalizado'];
  const projectStatus = PROJECT_STATUSES.includes(req.body.project_status) ? req.body.project_status : 'Vigente';
  let logoPath = company.logo_path;
  if (logoFile) {
    if (company.logo_path) { try { fs.unlinkSync(path.join(LOGOS_DIR, company.logo_path)); } catch (_) {} }
    logoPath = await processCompanyImage(logoFile);
  }
  let esloPath = company.eslogan_path;
  if (esloFile) {
    if (company.eslogan_path) { try { fs.unlinkSync(path.join(LOGOS_DIR, company.eslogan_path)); } catch (_) {} }
    esloPath = await processCompanyImage(esloFile);
  }
  db.prepare('UPDATE companies SET name = ?, contact = ?, notes = ?, project = ?, eslogan = ?, project_status = ?, logo_path = ?, eslogan_path = ? WHERE id = ?').run(name, contact, notes, project, eslogan, projectStatus, logoPath, esloPath, company.id);
  logAction(req.session.userId, 'company_edit', name, req.ip);
  req.session.flash = { type: 'success', text: 'Empresa actualizada.' };
  res.redirect('/admin/empresas');
});

// ───────── Gestión de proyectos por empresa ─────────
const PROJ_STATUSES = ['Vigente', 'En pausa', 'Finalizado'];

// Redirección de vuelta segura (la página que originó la acción)
function projBack(req) {
  const b = String(req.body.back || '');
  return (b === '/admin/proyectos' || b === '/admin/empresas') ? b : '/admin/empresas';
}

// Alta de proyecto eligiendo la empresa (desde la página /admin/proyectos)
router.post('/proyectos', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(req.body.company_id);
  if (!company) {
    req.session.flash = { type: 'error', text: 'Selecciona una empresa válida (debe estar registrada antes).' };
    return res.redirect('/admin/proyectos');
  }
  const name = String(req.body.name || '').trim().slice(0, 160);
  const status = PROJ_STATUSES.includes(req.body.status) ? req.body.status : 'Vigente';
  if (!name) {
    req.session.flash = { type: 'error', text: 'El nombre del proyecto es obligatorio.' };
    return res.redirect('/admin/proyectos');
  }
  db.prepare('INSERT INTO projects (company_id, name, status) VALUES (?, ?, ?)').run(company.id, name, status);
  logAction(req.session.userId, 'project_create', `${company.name}: ${name}`, req.ip);
  req.session.flash = { type: 'success', text: `Proyecto "${name}" agregado a ${company.name}.` };
  res.redirect('/admin/proyectos');
});

router.post('/empresas/:id/proyectos', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(req.params.id);
  if (!company) return res.status(404).render('error', { title: 'No encontrado', message: 'Empresa no encontrada.' });
  const name = String(req.body.name || '').trim().slice(0, 160);
  const status = PROJ_STATUSES.includes(req.body.status) ? req.body.status : 'Vigente';
  if (!name) {
    req.session.flash = { type: 'error', text: 'El nombre del proyecto es obligatorio.' };
    return res.redirect('/admin/empresas');
  }
  db.prepare('INSERT INTO projects (company_id, name, status) VALUES (?, ?, ?)').run(company.id, name, status);
  logAction(req.session.userId, 'project_create', `${company.name}: ${name}`, req.ip);
  req.session.flash = { type: 'success', text: `Proyecto "${name}" agregado a ${company.name}.` };
  res.redirect('/admin/empresas');
});

router.post('/proyectos/:id/edit', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).render('error', { title: 'No encontrado', message: 'Proyecto no encontrado.' });
  const name = String(req.body.name || '').trim().slice(0, 160) || proj.name;
  const status = PROJ_STATUSES.includes(req.body.status) ? req.body.status : proj.status;
  const pct = (v) => Math.max(0, Math.min(100, parseInt(v, 10) || 0));
  const f2 = pct(req.body.fase2_pct), f3 = pct(req.body.fase3_pct), f4 = pct(req.body.fase4_pct);
  db.prepare('UPDATE projects SET name = ?, status = ?, fase2_pct = ?, fase3_pct = ?, fase4_pct = ? WHERE id = ?')
    .run(name, status, f2, f3, f4, proj.id);
  logAction(req.session.userId, 'project_edit', name, req.ip);
  req.session.flash = { type: 'success', text: 'Proyecto actualizado.' };
  res.redirect(projBack(req));
});

router.post('/proyectos/:id/delete', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).render('error', { title: 'No encontrado', message: 'Proyecto no encontrado.' });
  const minutas = db.prepare('SELECT COUNT(*) AS n FROM minutas WHERE project_id = ?').get(proj.id).n;
  const ivs = db.prepare('SELECT COUNT(*) AS n FROM interviews WHERE project_id = ?').get(proj.id).n;
  if (minutas > 0 || ivs > 0) {
    req.session.flash = { type: 'error', text: `No puedes eliminar "${proj.name}": tiene ${minutas} minuta(s) y ${ivs} entrevista(s) asociadas.` };
    return res.redirect(projBack(req));
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
  logAction(req.session.userId, 'project_delete', proj.name, req.ip);
  req.session.flash = { type: 'success', text: `Proyecto "${proj.name}" eliminado.` };
  res.redirect(projBack(req));
});

// ───────── Contrato del proyecto (subir, firmar e.firma, enviar al cliente) ─────────
function contratoFile(p, res) {
  if (!p || !p.contrato_path) { res.status(404).send('Sin contrato'); return null; }
  const fp = path.join(CONTRATOS_DIR, p.contrato_path);
  if (!fs.existsSync(fp)) { res.status(404).send('Archivo no encontrado'); return null; }
  return fp;
}

// Subir / reemplazar el contrato (PDF)
// Guarda el PDF en un proyecto y reinicia cualquier firma previa
function guardarContratoEnProyecto(proj, file, userId, ip) {
  db.prepare(`UPDATE projects SET contrato_path=?, contrato_nombre=?, contrato_enviado=0,
              cont_firmada=0, cont_firma_serial=NULL, cont_firma_nombre=NULL, cont_firma_fecha=NULL,
              cont_firma_folio=NULL, cont_firma_email=NULL, cont_firma_rfc=NULL, cont_firma_hash=NULL,
              cont_firma_sello=NULL, cont_firma_cert=NULL, cont_firma_slots=NULL,
              cont_firmada_cliente=0, cont_fc_serial=NULL, cont_fc_nombre=NULL, cont_fc_fecha=NULL,
              cont_fc_folio=NULL, cont_fc_email=NULL, cont_fc_rfc=NULL, cont_fc_hash=NULL,
              cont_fc_sello=NULL, cont_fc_cert=NULL WHERE id=?`)
    .run(file.filename, file.originalname, proj.id);
  logAction(userId, 'contrato_subido', proj.name, ip);
}

router.post('/proyectos/:id/contrato', requireAdmin, contratoUpload.single('contrato'), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).render('error', { title: 'No encontrado', message: 'Proyecto no encontrado.' });
  if (!req.file) {
    req.session.flash = { type: 'error', text: 'Sube un archivo PDF del contrato.' };
    return res.redirect('/admin/proyectos');
  }
  guardarContratoEnProyecto(proj, req.file, req.session.userId, req.ip);
  req.session.flash = { type: 'success', text: 'Contrato cargado. Ya puedes firmarlo con tu e.firma.' };
  res.redirect('/admin/proyectos');
});

// Nuevo contrato: elegir el proyecto y subir el PDF (desde Gestión de Minutas y Contratos)
router.post('/contratos/subir', requireAdmin, contratoUpload.single('contrato'), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(parseInt(req.body.project_id, 10) || 0);
  if (!proj) {
    req.session.flash = { type: 'error', text: 'Selecciona un proyecto válido para el contrato.' };
    return res.redirect('/admin/minutas');
  }
  if (!req.file) {
    req.session.flash = { type: 'error', text: 'Sube un archivo PDF del contrato.' };
    return res.redirect('/admin/minutas');
  }
  guardarContratoEnProyecto(proj, req.file, req.session.userId, req.ip);
  req.session.flash = { type: 'success', text: `Contrato cargado en "${proj.name}". Ya puedes firmarlo con tu e.firma.` };
  res.redirect('/admin/minutas');
});

// Firmar el contrato con e.firma (BusinessCool)
router.post('/proyectos/:id/contrato/firmar', requireAdmin,
  memUploadFirma.fields([{ name: 'key_file', maxCount: 1 }, { name: 'cer_file', maxCount: 1 }]),
  async (req, res) => {
    if (!verifyCsrf(req)) return denyCsrf(res);
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!proj || !proj.contrato_path) {
      req.session.flash = { type: 'error', text: 'Primero sube el contrato.' };
      return res.redirect('/admin/proyectos');
    }
    const keyFile = req.files && req.files['key_file'] && req.files['key_file'][0];
    const cerFile = req.files && req.files['cer_file'] && req.files['cer_file'][0];
    const passphrase = String(req.body.passphrase || '');
    if (!keyFile || !cerFile || !passphrase) {
      req.session.flash = { type: 'error', text: 'Sube los archivos .key y .cer e ingresa la contraseña.' };
      return res.redirect('/admin/proyectos');
    }
    try {
      await firmarContrato(proj.id, proj, keyFile.buffer, cerFile.buffer, passphrase, req.session.userId, req.ip);
      req.session.flash = { type: 'success', text: 'Contrato firmado con e.firma. Ahora puedes enviarlo al cliente responsable.' };
    } catch (err) {
      req.session.flash = { type: 'error', text: 'Error al firmar: ' + err.message };
    }
    res.redirect('/admin/proyectos');
  });

// Enviar el contrato al cliente responsable para su firma
router.post('/proyectos/:id/contrato/enviar', requireAdmin, async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const back = (typeof req.body.back === 'string' && /^\/admin(\/|$|\?)/.test(req.body.back)) ? req.body.back : '/admin/proyectos';
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj || !proj.contrato_path) return res.redirect(back);
  if (!proj.cont_firmada) {
    req.session.flash = { type: 'error', text: 'Firma el contrato con tu e.firma antes de enviarlo al cliente.' };
    return res.redirect(back);
  }
  // Una vez firmado por ambas partes, el envío queda cerrado (no se puede retirar)
  if (proj.contrato_enviado && proj.cont_firmada && proj.cont_firmada_cliente) {
    req.session.flash = { type: 'error', text: 'El contrato ya está firmado por ambas partes; no se puede retirar el envío.' };
    return res.redirect(back);
  }
  const enviado = proj.contrato_enviado ? 0 : 1;
  db.prepare('UPDATE projects SET contrato_enviado=? WHERE id=?').run(enviado, proj.id);
  logAction(req.session.userId, enviado ? 'contrato_enviado' : 'contrato_retirado', proj.name, req.ip);
  if (enviado) {
    try { await notificarDocumentoEnviado(proj.company_id, { kind: 'contrato', title: proj.name }); } catch (_) { /* best-effort */ }
  }
  req.session.flash = { type: 'success', text: enviado
    ? 'Contrato enviado al cliente responsable (se le notificó por correo y en la plataforma).'
    : 'Envío retirado: el cliente ya no verá el contrato.' };
  res.redirect(back);
});

// Eliminar el contrato
router.post('/proyectos/:id/contrato/eliminar', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.redirect('/admin/proyectos');
  db.prepare(`UPDATE projects SET contrato_path=NULL, contrato_nombre=NULL, contrato_enviado=0,
              cont_firmada=0, cont_firmada_cliente=0 WHERE id=?`).run(proj.id);
  logAction(req.session.userId, 'contrato_eliminado', proj.name, req.ip);
  req.session.flash = { type: 'success', text: 'Contrato eliminado del proyecto.' };
  res.redirect('/admin/proyectos');
});

// Ver / descargar el contrato
router.get('/proyectos/:id/contrato/ver-pdf', (req, res) => {
  const proj = db.prepare('SELECT contrato_path FROM projects WHERE id = ?').get(req.params.id);
  const fp = contratoFile(proj, res);
  if (!fp) return;
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="contrato.pdf"');
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(fp).pipe(res);
});
router.get('/proyectos/:id/contrato/descargar', (req, res) => {
  const proj = db.prepare('SELECT contrato_path, contrato_nombre FROM projects WHERE id = ?').get(req.params.id);
  const fp = contratoFile(proj, res);
  if (!fp) return;
  res.download(fp, proj.contrato_nombre || 'contrato.pdf');
});

// ───────── Información requerida (check list por proyecto) ─────────
const CHECKLIST_DIR = path.join(config.uploadsDir, 'checklist');
if (!fs.existsSync(CHECKLIST_DIR)) fs.mkdirSync(CHECKLIST_DIR, { recursive: true });

function checklistProject(req) {
  const pid = parseInt(req.query.proyecto, 10) || parseInt(req.session.adminProjectId, 10) || null;
  if (!pid) return null;
  return db.prepare(
    'SELECT p.*, c.name AS company_name FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.id = ?'
  ).get(pid) || null;
}

// Página del check list (admin ve items + archivos entregados)
router.get('/informacion', (req, res) => {
  const proj = checklistProject(req);
  const items = proj
    ? db.prepare('SELECT * FROM checklist_items WHERE project_id = ? ORDER BY id').all(proj.id)
    : [];
  const filesByItem = {};
  const msgsByItem = {};
  const unreadByItem = {};
  const uid = req.session.userId;
  items.forEach((it) => {
    filesByItem[it.id] = db.prepare('SELECT * FROM checklist_files WHERE item_id = ? ORDER BY id').all(it.id);
    msgsByItem[it.id] = db.prepare('SELECT * FROM checklist_messages WHERE item_id = ? ORDER BY id').all(it.id);
    const seen = db.prepare('SELECT last_seen_id FROM checklist_seen WHERE item_id = ? AND user_id = ?').get(it.id, uid);
    const lastSeen = seen ? seen.last_seen_id : 0;
    unreadByItem[it.id] = db.prepare("SELECT COUNT(*) AS n FROM checklist_messages WHERE item_id = ? AND role != 'businesscool' AND id > ?").get(it.id, lastSeen).n;
  });
  res.render('admin/informacion', {
    title: 'Información requerida', active: 'informacion',
    proj, items, filesByItem, msgsByItem, unreadByItem, canManage: req.session.role === 'admin',
  });
});

// Eliminar un mensaje del hilo (solo admin)
router.post('/informacion/mensaje/:mid/eliminar', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare(
    'SELECT cm.id, ci.project_id FROM checklist_messages cm JOIN checklist_items ci ON ci.id = cm.item_id WHERE cm.id = ?'
  ).get(req.params.mid);
  if (!m) return res.redirect('/admin/informacion');
  db.prepare('DELETE FROM checklist_messages WHERE id = ?').run(m.id);
  logAction(req.session.userId, 'checklist_msg_del', '#' + m.id, req.ip);
  req.session.flash = { type: 'success', text: 'Mensaje eliminado.' };
  res.redirect(`/admin/informacion?proyecto=${m.project_id}`);
});

// Eliminar toda la conversación de un punto (solo admin)
router.post('/informacion/:id/conversacion/eliminar', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const it = db.prepare('SELECT id, project_id, titulo FROM checklist_items WHERE id = ?').get(req.params.id);
  if (!it) return res.redirect('/admin/informacion');
  db.prepare('DELETE FROM checklist_messages WHERE item_id = ?').run(it.id);
  logAction(req.session.userId, 'checklist_conv_del', it.titulo, req.ip);
  req.session.flash = { type: 'success', text: 'Conversación eliminada.' };
  res.redirect(`/admin/informacion?proyecto=${it.project_id}`);
});

// Marcar como leídos los mensajes de un punto (para el usuario actual)
router.post('/informacion/:id/visto', (req, res) => {
  if (!verifyCsrf(req)) return res.status(403).json({ ok: false });
  const it = db.prepare('SELECT id FROM checklist_items WHERE id = ?').get(req.params.id);
  if (!it) return res.json({ ok: false });
  const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM checklist_messages WHERE item_id = ?').get(it.id).m;
  db.prepare(`INSERT INTO checklist_seen (item_id, user_id, last_seen_id) VALUES (?, ?, ?)
              ON CONFLICT(item_id, user_id) DO UPDATE SET last_seen_id = excluded.last_seen_id`)
    .run(it.id, req.session.userId, max);
  res.json({ ok: true });
});

// Mensaje del equipo BusinessCool en el hilo de un punto
router.post('/informacion/:id/mensaje', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const it = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(req.params.id);
  if (!it) return res.redirect('/admin/informacion');
  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (!body) { req.session.flash = { type: 'error', text: 'Escribe un mensaje.' }; return res.redirect(`/admin/informacion?proyecto=${it.project_id}`); }
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.session.userId);
  db.prepare('INSERT INTO checklist_messages (item_id, role, author, body) VALUES (?, ?, ?, ?)')
    .run(it.id, 'businesscool', (me && me.display_name) || 'BusinessCool AI', body);
  logAction(req.session.userId, 'checklist_msg', it.titulo, req.ip);
  try {
    const proj = db.prepare('SELECT company_id FROM projects WHERE id = ?').get(it.project_id);
    const { notifyResponsables } = require('../lib/notifications');
    if (proj) notifyResponsables(proj.company_id, { title: 'Nuevo mensaje de BusinessCool', body: `${it.titulo}: ${body}`.slice(0, 200), link: '/app/informacion' });
  } catch (_) { /* best-effort */ }
  req.session.flash = { type: 'success', text: 'Mensaje enviado al cliente.' };
  res.redirect(`/admin/informacion?proyecto=${it.project_id}`);
});

// Agregar puntos al check list (uno, o varios en bloque: una línea por punto)
router.post('/informacion', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(parseInt(req.body.project_id, 10) || 0);
  if (!proj) {
    req.session.flash = { type: 'error', text: 'Selecciona un proyecto válido.' };
    return res.redirect('/admin/informacion');
  }
  const back = `/admin/informacion?proyecto=${proj.id}`;
  const ins = db.prepare('INSERT INTO checklist_items (project_id, titulo, descripcion) VALUES (?, ?, ?)');
  let n = 0;
  const bulk = String(req.body.bulk || '').trim();
  if (bulk) {
    bulk.split(/\r?\n/).map((l) => l.replace(/^\s*[-•▪\d.)\]]+\s*/, '').trim()).filter(Boolean)
      .forEach((titulo) => { ins.run(proj.id, titulo.slice(0, 300), null); n++; });
  }
  const titulo = String(req.body.titulo || '').trim();
  if (titulo) { ins.run(proj.id, titulo.slice(0, 300), String(req.body.descripcion || '').trim().slice(0, 600) || null); n++; }
  if (!n) {
    req.session.flash = { type: 'error', text: 'Escribe al menos un punto para el check list.' };
    return res.redirect(back);
  }
  logAction(req.session.userId, 'checklist_items_added', `${proj.name} (+${n})`, req.ip);
  try {
    const { notifyResponsables } = require('../lib/notifications');
    notifyResponsables(proj.company_id, { title: 'Nueva información solicitada', body: `${proj.name}: ${n} punto(s) por entregar`, link: '/app/informacion' });
  } catch (_) { /* best-effort */ }
  req.session.flash = { type: 'success', text: `${n} punto(s) agregados al check list. El cliente responsable ya los ve en su portal.` };
  res.redirect(back);
});

router.post('/informacion/:id/edit', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const it = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(req.params.id);
  if (!it) return res.redirect('/admin/informacion');
  const titulo = String(req.body.titulo || '').trim().slice(0, 300) || it.titulo;
  const descripcion = String(req.body.descripcion || '').trim().slice(0, 600) || null;
  const responsable = String(req.body.responsable || '').trim().slice(0, 120) || null;
  const respCargo = String(req.body.responsable_cargo || '').trim().slice(0, 120) || null;
  const respArea = String(req.body.responsable_area || '').trim().slice(0, 120) || null;
  db.prepare('UPDATE checklist_items SET titulo = ?, descripcion = ?, responsable = ?, responsable_cargo = ?, responsable_area = ? WHERE id = ?')
    .run(titulo, descripcion, responsable, respCargo, respArea, it.id);
  req.session.flash = { type: 'success', text: 'Punto actualizado.' };
  res.redirect(`/admin/informacion?proyecto=${it.project_id}`);
});

// Marcar / desmarcar un punto como validado (recibido y correcto)
router.post('/informacion/:id/validar', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const it = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(req.params.id);
  if (!it) return res.redirect('/admin/informacion');
  db.prepare('UPDATE checklist_items SET validado = ? WHERE id = ?').run(it.validado ? 0 : 1, it.id);
  res.redirect(`/admin/informacion?proyecto=${it.project_id}`);
});

router.post('/informacion/:id/delete', requireAdmin, (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const it = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(req.params.id);
  if (!it) return res.redirect('/admin/informacion');
  db.prepare('SELECT file_path FROM checklist_files WHERE item_id = ?').all(it.id).forEach((f) => {
    try { fs.unlinkSync(path.join(CHECKLIST_DIR, f.file_path)); } catch (_) { /* ya no existe */ }
  });
  db.prepare('DELETE FROM checklist_files WHERE item_id = ?').run(it.id);
  db.prepare('DELETE FROM checklist_items WHERE id = ?').run(it.id);
  req.session.flash = { type: 'success', text: 'Punto eliminado del check list.' };
  res.redirect(`/admin/informacion?proyecto=${it.project_id}`);
});

// Descargar un archivo entregado por el cliente
router.get('/informacion/archivo/:fid/descargar', (req, res) => {
  const f = db.prepare('SELECT * FROM checklist_files WHERE id = ?').get(req.params.fid);
  if (!f) return res.status(404).send('Archivo no encontrado');
  const fp = path.join(CHECKLIST_DIR, f.file_path);
  if (!fs.existsSync(fp)) return res.status(404).send('Archivo no encontrado en servidor');
  res.download(fp, f.file_name);
});

router.post('/empresas/:id/delete', requireAdmin, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!company) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Empresa no encontrada.' });
  }
  const count = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE company_id = ?`).get(company.id).n;
  if (count > 0) {
    req.session.flash = {
      type: 'error',
      text: `No puedes eliminar "${company.name}": tiene ${count} usuario(s). Elimina o reasigna sus usuarios primero.`,
    };
    return res.redirect('/admin/empresas');
  }
  if (company.logo_path) { try { fs.unlinkSync(path.join(LOGOS_DIR, company.logo_path)); } catch (_) {} }
  if (company.eslogan_path) { try { fs.unlinkSync(path.join(LOGOS_DIR, company.eslogan_path)); } catch (_) {} }
  db.prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  logAction(req.session.userId, 'company_delete', company.name, req.ip);
  req.session.flash = { type: 'success', text: `Empresa "${company.name}" eliminada.` };
  res.redirect('/admin/empresas');
});

// ============================ USUARIOS ============================
router.get('/usuarios', (req, res) => {
  const users = db
    .prepare(
      `SELECT u.*, co.name AS company_name_real,
              (SELECT COUNT(*) FROM files f WHERE f.client_id = u.id AND f.direction = 'to_admin') AS files_in,
              (SELECT COUNT(*) FROM interviews iv WHERE iv.client_id = u.id) AS links
       FROM users u LEFT JOIN companies co ON co.id = u.company_id
       WHERE u.role IN ('client', 'colaborador', 'cliente_responsable') ORDER BY u.created_at DESC`
    )
    .all();

  const clients = users.filter((u) => u.role !== 'colaborador');
  const summary = {
    total: users.length,
    collaborators: users.filter((u) => u.role === 'colaborador').length,
    withInterview: clients.filter((u) => u.links > 0).length,
    pending: clients.filter((u) => u.active && (u.links === 0 || u.files_in === 0)).length,
  };

  // Capturamos y borramos antes del render: las credenciales se muestran una sola vez.
  const newCredentials = req.session.newCredentials || null;
  delete req.session.newCredentials;

  res.render('admin/usuarios', {
    title: 'Usuarios',
    active: 'usuarios',
    users,
    companies: activeCompanies(),
    summary,
    newCredentials,
    canManage: req.session.role === 'admin',
    openNew: !!req.query.nuevo,
  });
});

// Crear un usuario. role = 'client' (cliente de una empresa) o 'colaborador'
// (equipo BusinessCool, sin empresa).
router.post('/usuarios', requireAdmin, async (req, res) => {
  const role = ['colaborador', 'cliente_responsable'].includes(req.body.role) ? req.body.role : 'client';

  let company = null;
  if (role !== 'colaborador') {
    company = db.prepare(`SELECT * FROM companies WHERE id = ? AND active = 1`).get(req.body.company_id);
    if (!company) {
      req.session.flash = { type: 'error', text: 'Selecciona una empresa válida para el usuario cliente. Si no hay, créala en Empresas primero.' };
      return res.redirect('/admin/usuarios');
    }
  }

  const displayName = String(req.body.display_name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  let password = String(req.body.password || '').trim();

  // El correo electrónico es el identificador de acceso (login)
  if (!email || !EMAIL_RE.test(email)) {
    req.session.flash = { type: 'error', text: 'El correo electrónico es obligatorio y debe ser válido (es el acceso del usuario).' };
    return res.redirect('/admin/usuarios');
  }
  const username = email;
  if (db.prepare('SELECT id FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?').get(username, email)) {
    req.session.flash = { type: 'error', text: 'Ya existe un usuario con ese correo.' };
    return res.redirect('/admin/usuarios');
  }
  if (!password) password = tempPassword();
  if (password.length < 10) {
    req.session.flash = { type: 'error', text: 'La contraseña temporal debe tener al menos 10 caracteres.' };
    return res.redirect('/admin/usuarios');
  }

  const companyName = company ? company.name : config.brand.name;
  const companyId = company ? company.id : null;

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, company_name, company_id, email, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(username, hash, role, displayName || username, companyName, companyId, email || null);
  logAction(req.session.userId, 'create_user', `${username} (${role}: ${companyName})`, req.ip);

  let mailMsg = '';
  if (email) {
    const result = await sendWelcomeEmail({ to: email, displayName: displayName || username, username, password, companyName });
    mailMsg = result.sent ? ` Correo de bienvenida enviado a ${email}.` : ` (No se pudo enviar el correo: ${result.error}.)`;
  }

  const label = role === 'colaborador' ? 'Colaborador' : 'Usuario';
  req.session.newCredentials = { username, password };
  req.session.flash = { type: 'success', text: `${label} creado.${mailMsg} Copia y comparte las credenciales por un canal seguro.` };
  res.redirect('/admin/usuarios');
});

// La ficha de detalle ya no se usa: redirige a la lista de usuarios
router.get('/usuarios/:id', (req, res) => res.redirect('/admin/usuarios'));

// Compartir archivo(s) con el usuario desde su ficha
router.post('/usuarios/:id/upload', upload.array('files', 10), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);

  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Usuario no encontrado.' });
  }

  const files = req.files || [];
  if (files.length === 0) {
    req.session.flash = { type: 'error', text: 'No seleccionaste ningún archivo.' };
    return res.redirect(`/admin/usuarios/${client.id}`);
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

  req.session.flash = { type: 'success', text: 'Archivo(s) compartido(s) con el usuario.' };
  res.redirect(`/admin/usuarios/${client.id}`);
});

// Editar un usuario (acceso, nombre, empresa, rol, correo)
router.post('/usuarios/:id/edit', requireAdmin, (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role IN ('client', 'colaborador', 'cliente_responsable')`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Usuario no encontrado.' });
  }
  const displayName = String(req.body.display_name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const role = ['colaborador', 'cliente_responsable'].includes(req.body.role) ? req.body.role : 'client';
  const back = `/admin/usuarios/${client.id}`;

  // El correo es el identificador de acceso
  if (!email || !EMAIL_RE.test(email)) {
    req.session.flash = { type: 'error', text: 'El correo electrónico es obligatorio y debe ser válido (es el acceso del usuario).' };
    return res.redirect(back);
  }
  const username = email;
  if (db.prepare('SELECT id FROM users WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND id <> ?').get(username, email, client.id)) {
    req.session.flash = { type: 'error', text: 'Ya existe otra cuenta con ese correo.' };
    return res.redirect(back);
  }

  let company = null;
  if (role !== 'colaborador') {
    company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.body.company_id);
    if (!company) {
      req.session.flash = { type: 'error', text: 'Selecciona una empresa válida para el usuario cliente.' };
      return res.redirect(back);
    }
  }

  db.prepare('UPDATE users SET username = ?, display_name = ?, role = ?, company_id = ?, company_name = ?, email = ? WHERE id = ?').run(
    username,
    displayName || username,
    role,
    company ? company.id : null,
    company ? company.name : config.brand.name,
    email || null,
    client.id
  );
  logAction(req.session.userId, 'edit_user', `${client.username} -> ${username} (${role})`, req.ip);
  req.session.flash = { type: 'success', text: 'Información del usuario actualizada.' };
  res.redirect(back);
});

// Restablecer contraseña de un usuario
router.post('/usuarios/:id/reset-password', requireAdmin, async (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role IN ('client', 'colaborador', 'cliente_responsable')`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Usuario no encontrado.' });
  }
  const password = tempPassword();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, client.id);
  logAction(req.session.userId, 'reset_password', client.username, req.ip);

  let mailMsg = '';
  if (client.email) {
    const result = await sendWelcomeEmail({
      to: client.email, displayName: client.display_name || client.username,
      username: client.username, password, companyName: client.company_name,
    });
    mailMsg = result.sent ? ` Nueva contraseña enviada a ${client.email}.` : ` (No se pudo enviar el correo: ${result.error}.)`;
  }

  req.session.newCredentials = { username: client.username, password };
  req.session.flash = { type: 'success', text: `Contraseña restablecida.${mailMsg} Comparte la nueva por un canal seguro.` };
  res.redirect('/admin/usuarios');
});

// Activar / desactivar acceso de un usuario
router.post('/usuarios/:id/toggle-active', requireAdmin, (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role IN ('client', 'colaborador', 'cliente_responsable')`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Usuario no encontrado.' });
  }
  const next = client.active ? 0 : 1;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(next, client.id);
  logAction(req.session.userId, next ? 'enable_user' : 'disable_user', client.username, req.ip);
  req.session.flash = { type: 'success', text: next ? 'Usuario activado.' : 'Usuario desactivado.' };
  res.redirect('/admin/usuarios');
});

// Eliminar un usuario por completo (sus entrevistas, archivos y comentarios)
router.post('/usuarios/:id/delete', requireAdmin, (req, res) => {
  const client = db.prepare(`SELECT * FROM users WHERE id = ? AND role IN ('client', 'colaborador', 'cliente_responsable')`).get(req.params.id);
  if (!client) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Usuario no encontrado.' });
  }
  const files = db.prepare('SELECT stored_name FROM files WHERE client_id = ?').all(client.id);
  for (const f of files) {
    const abs = path.join(config.uploadsDir, f.stored_name);
    if (abs.startsWith(config.uploadsDir)) fs.unlink(abs, () => {});
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(client.id);
  logAction(req.session.userId, 'delete_user', client.username, req.ip);

  req.session.flash = { type: 'success', text: `Usuario "${client.display_name || client.username}" eliminado.` };
  res.redirect('/admin/usuarios');
});

// Compatibilidad: la antigua "Clientes" ahora son Usuarios
router.get('/gestion', (req, res) => res.redirect('/admin/usuarios'));

module.exports = router;
