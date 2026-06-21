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
    `SELECT p.id, p.name, p.status, p.company_id, c.name AS company_name
     FROM projects p JOIN companies c ON c.id = p.company_id
     ORDER BY c.name, p.created_at, p.id`
  ).all().map((p) => {
    const cnt = projectsLib.counts(p.id);
    return { id: p.id, name: p.name, status: p.status, company: p.company_name,
             files: cnt.files, minutas: cnt.minutas, interviews: cnt.interviews };
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
  db.prepare('UPDATE projects SET name = ?, status = ? WHERE id = ?').run(name, status, proj.id);
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

// Detalle de un usuario
router.get('/usuarios/:id', (req, res) => {
  const cliente = db
    .prepare(
      `SELECT u.*, co.name AS company_name_real
       FROM users u LEFT JOIN companies co ON co.id = u.company_id
       WHERE u.id = ? AND u.role IN ('client', 'colaborador', 'cliente_responsable')`
    )
    .get(req.params.id);
  if (!cliente) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Usuario no encontrado.' });
  }

  const filesFromClient = db
    .prepare(`SELECT * FROM files WHERE client_id = ? AND direction = 'to_admin' ORDER BY created_at DESC`)
    .all(cliente.id);
  const filesToClient = db
    .prepare(`SELECT * FROM files WHERE client_id = ? AND direction = 'to_client' ORDER BY created_at DESC`)
    .all(cliente.id);
  const interviews = db
    .prepare(`SELECT * FROM interviews WHERE client_id = ? ORDER BY created_at DESC`)
    .all(cliente.id);

  res.render('admin/client', {
    title: cliente.display_name || cliente.username,
    active: 'usuarios',
    cliente,
    companies: activeCompanies(),
    filesFromClient,
    filesToClient,
    interviews,
    allowedExt: config.allowedExt,
    maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
    canManage: req.session.role === 'admin',
  });
});

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
