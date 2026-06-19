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
    state: 'current', label: 'En curso', name: 'Diagnóstico As-Is', sub: 'Levantamiento del estado actual',
    items: [
      {
        n: 1, state: 'current', stateLabel: 'En proceso',
        t: 'Levantamiento de Requerimientos', paso: 'Paso 1 · Captura de Información',
        desc: 'Entrevistas y encuestas IMA con las partes interesadas para entender su proceso. Es la fuente de materia prima: se escucha activamente a usuarios, líderes de área y operadores para recolectar sus dolores, necesidades y expectativas sin filtros.',
      },
      {
        n: 2, state: 'pending', stateLabel: 'Pendiente',
        t: 'Mapeo de Procesos Actuales (As-Is)', paso: 'Paso 2 · Diagnóstico Fotográfico',
        desc: 'Documentar cómo se hacen las cosas actualmente. Con la información recolectada se plasma de forma visual y documental la realidad de la organización hoy, identificando cuellos de botella, retrabajos y tareas manuales que absorben tiempo excesivo.',
      },
      {
        n: 3, state: 'pending', stateLabel: 'Pendiente',
        t: 'Informe de Integración de Hallazgos', paso: 'Paso 3 · Análisis y Cruce de Datos',
        desc: 'Transformar datos dispersos en una lectura unificada. Cruza las notas de las entrevistas y el mapa As-Is para unificar criterios, detectar contradicciones entre áreas, datos duplicados y las brechas (gaps) entre la realidad actual y el potencial tecnológico.',
      },
    ],
    entregable: 'Mapa de procesos As-Is validado',
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

// Mi proyecto (pipeline)
router.get('/', (req, res) => {
  res.render('client/proyecto', {
    title: 'Mi proyecto', active: 'proyecto', companyName: companyOf(req),
    phase: PIPELINE[0],
    nextPhase: PIPELINE[1], // tarjeta resumen To-Be al final del carrusel
  });
});

// Entregables (archivos reales + aprobación de ejemplo)
router.get('/entregables', (req, res) => {
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

  res.render('client/entregables', {
    title: 'Entregables', active: 'entregables', companyName: companyOf(req),
    files, interviews, interview, deliverables: DELIVERABLES,
    maxFileMb: Math.round(config.maxFileBytes / (1024 * 1024)),
  });
});

// Minutas (ejemplo)
router.get('/minutas', (req, res) => {
  res.render('client/minutas', {
    title: 'Minutas', active: 'minutas', companyName: companyOf(req), minuta: SAMPLE_MINUTA,
  });
});

// Agente de levantamiento (entrevistas reales)
router.get('/agente', (req, res) => {
  const interviews = db
    .prepare(
      `SELECT iv.*, (SELECT COUNT(*) FROM files f WHERE f.interview_id = iv.id) AS file_count
       FROM interviews iv WHERE iv.client_id = ? ORDER BY iv.created_at DESC`
    )
    .all(req.session.userId);
  res.render('client/agente', {
    title: 'Agente de levantamiento', active: 'agente', companyName: companyOf(req), interviews,
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
