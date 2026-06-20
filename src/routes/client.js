'use strict';

const express = require('express');

const config = require('../config');
const { db, logAction } = require('../db');
const { upload } = require('../lib/upload');
const { makeFileRouter } = require('./files');
const { makeInterviewActionsRouter, getAccessibleInterview } = require('./interviews');
const {
  requireLogin,
  requireClientArea,
  requirePasswordChanged,
  verifyCsrf,
  denyCsrf,
} = require('../middleware/auth');

const router = express.Router();

// Todas las rutas requieren usuario de empresa (client o cliente_responsable)
router.use(requireLogin, requireClientArea, requirePasswordChanged);

// Acciones por archivo y por entrevista (ver, descargar, eliminar, comentar, link)
router.use(makeFileRouter());
router.use(makeInterviewActionsRouter());

// Empresa del usuario (para la cabecera)
function companyOf(req) {
  const me = db.prepare('SELECT company_name FROM users WHERE id = ?').get(req.session.userId);
  return me ? me.company_name : null;
}

// --- Contenido de ejemplo (estructura fija; se hará editable más adelante) ---
const PIPELINE = [
  {
    state: 'current', label: 'En curso', name: 'Diagnóstico y Levantamiento', sub: 'Levantamiento del estado actual',
    items: [
      {
        n: 1, state: 'current', stateLabel: 'En proceso',
        t: 'Levantamiento de Requerimientos', paso: 'Paso 1 · Captura de Información',
        desc: 'Conversamos contigo y tu equipo para entender cómo funciona tu operación hoy. Identificamos tus retos, necesidades y objetivos para que el proyecto esté alineado desde el inicio con lo que realmente importa para tu organización.',
      },
      {
        n: 2, state: 'pending', stateLabel: 'Pendiente',
        t: 'Mapeo de Procesos Actuales (As-Is)', paso: 'Paso 2 · Diagnóstico Fotográfico',
        desc: 'Documentamos de forma visual cómo opera tu organización hoy. Detectamos los cuellos de botella, tareas repetitivas y áreas de mejora en tus procesos actuales para tener un diagnóstico claro y objetivo.',
      },
      {
        n: 3, state: 'pending', stateLabel: 'Pendiente',
        t: 'Informe de Integración de Hallazgos', paso: 'Paso 3 · Análisis y Cruce de Datos',
        desc: 'Consolidamos toda la información recopilada en un informe ejecutivo. Te presentamos los hallazgos clave, las brechas identificadas entre tu operación actual y tu potencial, y las oportunidades concretas de mejora con IA.',
      },
      {
        n: 4, state: 'pending', stateLabel: 'Pendiente',
        t: 'Mapeo de Procesos Deseados (To-Be)', paso: 'Paso 4 · Rediseño Optimizado',
        desc: 'Diseñamos juntos cómo debería operar tu organización con IA integrada. Te mostramos el proceso ideal: optimizado, automatizado y listo para implementar, con una visión clara del cambio que verás en tu operación.',
      },
    ],
    entregable: 'Diagnóstico y Levantamiento',
  },
  {
    state: 'pending', label: 'Pendiente', name: 'Rediseño To-Be', sub: 'Arquitectura futura con IA',
    items: [
      { t: 'Arquitectura de procesos To-Be', s: '' },
      { t: 'Puntos de fricción + IA estratégica', s: '' },
      { t: 'Business case de automatización', s: '' },
    ],
    entregable: 'Modelo To-Be aprobado por el cliente',
  },
  {
    state: 'pending', label: 'Pendiente', name: 'Desarrollo a la medida', sub: 'Construcción y despliegue',
    items: [
      { t: 'MVP de la solución de IA', s: '' },
      { t: 'Integración con sistemas core', s: '' },
    ],
    entregable: 'Solución en producción',
  },
  {
    state: 'pending', label: 'Pendiente', name: 'Implementación y cierre', sub: 'Pruebas · capacitación · cierre',
    items: [
      { t: 'Pruebas y ajustes', s: '' },
      { t: 'Capacitación y entrega', s: '' },
    ],
    entregable: 'Acta de cierre del proyecto',
  },
];

const DELIVERABLES = [
  { fase: 'F1', name: 'Inventario de procesos actuales', phase: 'Diagnóstico As-Is', status: 'aprob' },
  { fase: 'F1', name: 'Encuestas al personal (As-Is)', phase: 'Diagnóstico As-Is', status: 'aprob' },
  { fase: 'F1', name: 'Mapa de procesos As-Is', phase: 'Diagnóstico As-Is', status: 'aprob' },
  { fase: 'F2', name: 'Arquitectura de procesos To-Be', phase: 'Rediseño To-Be', status: 'rev' },
  { fase: 'F2', name: 'Puntos de fricción + IA estratégica', phase: 'Rediseño To-Be', status: 'pend' },
  { fase: 'F2', name: 'Business case de automatización', phase: 'Rediseño To-Be', status: 'pend' },
];

const SAMPLE_MINUTA = {
  summary:
    'Resumen de ejemplo: se revisó el avance del rediseño To-Be y se acordaron los compromisos de la semana. ' +
    'Esta minuta es una muestra; la generación automática con IA se conectará en una etapa posterior.',
  commitments: [
    { t: 'Ajustar el modelo To-Be según comentarios', who: 'Equipo ' + config.brand.name, due: '—', status: 'rev' },
    { t: 'Validar requerimientos con el área', who: 'Cliente', due: '—', status: 'pend' },
    { t: 'Consolidar respuestas de encuestas As-Is', who: 'Equipo ' + config.brand.name, due: '—', status: 'aprob' },
  ],
};

// Mi proyecto (pipeline) — solo cliente_responsable; client va a entrevistas
router.get('/', (req, res) => {
  if (req.session.role === 'client') return res.redirect('/app/agente');
  res.render('client/proyecto', {
    title: 'Mi proyecto', active: 'proyecto', companyName: companyOf(req),
    phase: PIPELINE[0],
  });
});

// Entregables — cliente_responsable ve lista formal; client ve sus archivos
router.get('/entregables', (req, res) => {
  if (req.session.role === 'client') {
    const clientId = req.session.userId;
    let interview = null;
    if (req.query.entrevista) {
      const iv = getAccessibleInterview(req, req.query.entrevista);
      if (iv && iv.client_id === clientId) interview = iv;
    }
    const params = [clientId];
    let where = 'f.client_id = ?';
    if (interview) { where += ' AND f.interview_id = ?'; params.push(interview.id); }

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

    return res.render('client/archivos', {
      title: 'Archivos', active: 'entregables', companyName: companyOf(req),
      files, interviews, interview,
      maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
    });
  }

  res.render('client/entregables', {
    title: 'Entregables', active: 'entregables', companyName: companyOf(req),
  });
});

// Descargar archivo adjunto de una minuta publicada
router.get('/minutas/:id/descargar', (req, res) => {
  if (req.session.role === 'client') return res.redirect('/app/agente');
  const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
  const m  = db.prepare('SELECT * FROM minutas WHERE id = ? AND publicada = 1').get(req.params.id);
  if (!m || !m.archivo_path) return res.status(404).send('Archivo no encontrado.');
  const allowed = me && (
    (me.company_id && me.company_id === m.company_id) ||
    (!m.company_id && me.company_name === m.company_name)
  );
  if (!allowed) return res.status(403).send('Sin acceso.');
  const path = require('path');
  const fs   = require('fs');
  const filePath = path.join(require('../config').uploadsDir, 'minutas', m.archivo_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado en servidor.');
  res.download(filePath, m.archivo_nombre || m.archivo_path);
});

// Previsualizar PDF de una minuta publicada (para el colocador de firma)
router.get('/minutas/:id/ver-pdf', (req, res) => {
  if (req.session.role === 'client') return res.status(403).send('Sin acceso.');
  const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
  const m  = db.prepare('SELECT * FROM minutas WHERE id = ? AND publicada = 1').get(req.params.id);
  if (!m || !m.archivo_path) return res.status(404).send('Sin archivo');
  const allowed = me && (
    (me.company_id && me.company_id === m.company_id) ||
    (!m.company_id && me.company_name === m.company_name)
  );
  if (!allowed) return res.status(403).send('Sin acceso.');
  const path = require('path');
  const fs   = require('fs');
  const filePath = path.join(require('../config').uploadsDir, 'minutas', m.archivo_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado');
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="minuta.pdf"');
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(filePath).pipe(res);
});

// Minutas — solo cliente_responsable (lee minutas publicadas de su empresa)
router.get('/minutas', (req, res) => {
  if (req.session.role === 'client') return res.redirect('/app/agente');
  const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
  const minutas = me
    ? db.prepare(
        `SELECT * FROM minutas
         WHERE publicada = 1
           AND (company_id = ? OR (company_id IS NULL AND company_name = ?))
         ORDER BY fecha DESC`
      ).all(me.company_id || -1, me.company_name || '')
    : [];
  res.render('client/minutas', {
    title: 'Minutas', active: 'minutas', companyName: companyOf(req), minutas,
  });
});

// Firma de minuta por el cliente con su e.firma (FIEL)
const multer = require('multer');
const { firmarPDFCliente } = require('../lib/minuta-firma');
const memUploadClient = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.post('/minutas/:id/firmar', memUploadClient.fields([{ name: 'key_file', maxCount: 1 }, { name: 'cer_file', maxCount: 1 }]), async (req, res) => {
  if (req.session.role === 'client') return res.redirect('/app/agente');
  if (!verifyCsrf(req)) return denyCsrf(res);

  const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
  const m  = db.prepare('SELECT * FROM minutas WHERE id = ? AND publicada = 1 AND firmada = 1').get(req.params.id);

  if (!m || !m.archivo_path) {
    req.session.flash = { type: 'error', text: 'Minuta no encontrada o no disponible para firmar.' };
    return res.redirect('/app/minutas');
  }

  const allowed = me && (
    (me.company_id && me.company_id === m.company_id) ||
    (!m.company_id && me.company_name === m.company_name)
  );
  if (!allowed) return res.status(403).send('Sin acceso.');

  if (m.firmada_cliente) {
    req.session.flash = { type: 'error', text: 'Esta minuta ya fue firmada por el cliente.' };
    return res.redirect('/app/minutas');
  }

  const keyFile    = req.files && req.files['key_file'] && req.files['key_file'][0];
  const cerFile    = req.files && req.files['cer_file'] && req.files['cer_file'][0];
  const passphrase = String(req.body.passphrase || '');

  if (!keyFile || !cerFile || !passphrase) {
    req.session.flash = { type: 'error', text: 'Sube los archivos .key y .cer e ingresa la contraseña.' };
    return res.redirect('/app/minutas');
  }

  try {
    const result = await firmarPDFCliente(m.id, m, keyFile.buffer, cerFile.buffer, passphrase, req.session.userId, req.ip);
    req.session.flash = { type: 'success', text: `Minuta firmada con tu e.firma. Folio cliente: ${result.folio}` };
  } catch (err) {
    req.session.flash = { type: 'error', text: 'Error al firmar: ' + err.message };
  }
  res.redirect('/app/minutas');
});

// Agente de levantamiento (entrevistas reales)
// cliente_responsable ve todas las entrevistas de su empresa
router.get('/agente', (req, res) => {
  let interviews;
  if (req.session.role === 'cliente_responsable') {
    const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
    const subq = me && me.company_id
      ? 'SELECT id FROM users WHERE company_id = ? AND active = 1'
      : 'SELECT id FROM users WHERE company_name = ? AND active = 1';
    const param = me && (me.company_id || me.company_name);
    interviews = param
      ? db.prepare(
          `SELECT iv.*, u.display_name AS client_name,
                  (SELECT COUNT(*) FROM files f WHERE f.interview_id = iv.id) AS file_count
           FROM interviews iv
           LEFT JOIN users u ON u.id = iv.client_id
           WHERE iv.client_id IN (${subq})
           ORDER BY iv.created_at DESC`
        ).all(param)
      : [];
  } else {
    interviews = db
      .prepare(
        `SELECT iv.*, (SELECT COUNT(*) FROM files f WHERE f.interview_id = iv.id) AS file_count
         FROM interviews iv WHERE iv.client_id = ? ORDER BY iv.created_at DESC`
      )
      .all(req.session.userId);
  }
  res.render('client/agente', {
    title: 'Entrevista', active: 'agente', companyName: companyOf(req), interviews,
    isResponsable: req.session.role === 'cliente_responsable',
  });
});

// Archivos de empresa (solo cliente_responsable — lee todos los archivos de su empresa)
router.get('/archivos', (req, res) => {
  if (req.session.role !== 'cliente_responsable') return res.redirect('/app/agente');
  const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
  const subq = me && me.company_id
    ? 'SELECT id FROM users WHERE company_id = ? AND active = 1'
    : 'SELECT id FROM users WHERE company_name = ? AND active = 1';
  const param = me && (me.company_id || me.company_name);
  const files = param
    ? db.prepare(
        `SELECT f.*,
                u.username AS owner_username, u.display_name AS owner_name, u.role AS owner_role,
                iv.nombre AS interview_nombre,
                (SELECT COUNT(*) FROM comments c WHERE c.file_id = f.id) AS comment_count
         FROM files f
         LEFT JOIN users u ON u.id = f.uploaded_by
         LEFT JOIN interviews iv ON iv.id = f.interview_id
         WHERE f.client_id IN (${subq})
         ORDER BY f.created_at DESC`
      ).all(param)
    : [];
  res.render('client/archivos', {
    title: 'Archivos', active: 'archivos-empresa', companyName: companyOf(req),
    files, interviews: [], interview: null, maxFileMb: 0, readonly: true,
  });
});

// Compatibilidad: /archivos ahora vive dentro de Entregables
router.get('/archivos', (req, res) => {
  const q = req.query.entrevista ? `?entrevista=${encodeURIComponent(req.query.entrevista)}` : '';
  res.redirect('/app/entregables' + q);
});

// Subida de archivos del usuario
router.post('/upload', upload.array('files', 10), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);

  const files = req.files || [];
  let interviewId = null;
  if (req.body.interview_id) {
    const iv = getAccessibleInterview(req, req.body.interview_id);
    if (iv && iv.client_id === req.session.userId) interviewId = iv.id;
  }
  const back = interviewId ? `/app/entregables?entrevista=${interviewId}` : '/app/entregables';

  if (files.length === 0) {
    req.session.flash = { type: 'error', text: 'No seleccionaste ningún archivo.' };
    return res.redirect(back);
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
  res.redirect(back);
});

module.exports = router;
