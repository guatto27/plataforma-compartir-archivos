'use strict';

const express = require('express');
const multer  = require('multer');
const forge   = require('node-forge');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const { db, logAction } = require('../db');
const config  = require('../config');
const { requireLogin, requireRole, verifyCsrf, denyCsrf } = require('../middleware/auth');
const { firmarPDF, MINUTAS_DIR } = require('../lib/minuta-firma');
const { renderMinutaPDF } = require('../lib/minuta-pdf');

const router = express.Router();
router.use(requireLogin, requireRole('admin', 'colaborador'));

if (!fs.existsSync(MINUTAS_DIR)) fs.mkdirSync(MINUTAS_DIR, { recursive: true });

// Multer en disco para archivos de minuta (PDF/DOCX)
const minutaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MINUTAS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.doc', '.xlsx', '.pptx'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Multer en memoria para .key / .cer (nunca se guardan en disco)
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Formatos disponibles para la minuta
const FORMATOS = [
  { id: 'ejecutiva',  label: 'Ejecutiva',   desc: 'Resumen breve con acuerdos y responsables' },
  { id: 'detallada',  label: 'Detallada',   desc: 'Todos los temas, participantes y seguimiento punto a punto' },
  { id: 'acta_formal', label: 'Acta formal', desc: 'Formato legal numerado con espacio para firmas' },
];

// ── Listar minutas ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const pid = parseInt(req.query.proyecto, 10) || null;
  const projectFilter = pid
    ? db.prepare('SELECT p.id, p.name, c.name AS company_name FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.id = ?').get(pid)
    : null;
  const minutas = projectFilter
    ? db.prepare(
        `SELECT m.*, u.display_name AS autor_nombre
         FROM minutas m LEFT JOIN users u ON u.id = m.created_by
         WHERE m.project_id = ? ORDER BY m.fecha DESC, m.created_at DESC`
      ).all(projectFilter.id)
    : db.prepare(
        `SELECT m.*, u.display_name AS autor_nombre
         FROM minutas m LEFT JOIN users u ON u.id = m.created_by
         ORDER BY m.fecha DESC, m.created_at DESC`
      ).all();
  const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  // Contratos: todos los proyectos (o el filtrado) con su estado de contrato/firma
  const contratos = db.prepare(
    `SELECT p.*, c.name AS company FROM projects p JOIN companies c ON c.id = p.company_id
     ${projectFilter ? 'WHERE p.id = ?' : ''} ORDER BY c.name, p.created_at, p.id`
  ).all(...(projectFilter ? [projectFilter.id] : []));
  res.render('admin/minutas', { title: 'Minutas y Contratos', active: 'minutas', minutas, empresas, FORMATOS, projectFilter, contratos });
});

// ── Nueva minuta ────────────────────────────────────────────────────────────
function allProjects() {
  return db.prepare(
    `SELECT p.id, p.name, p.company_id, c.name AS company_name
     FROM projects p JOIN companies c ON c.id = p.company_id
     ORDER BY c.name, p.created_at, p.id`
  ).all();
}

router.get('/nueva', (req, res) => {
  const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  res.render('admin/minuta-form', { title: 'Nueva minuta', active: 'minutas', minuta: null, empresas, proyectos: allProjects(), FORMATOS, error: null });
});

router.post('/nueva', minutaUpload.single('archivo'), async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const { titulo, fecha, company_id, company_name, formato, transcripcion, accion } = req.body;
  if (!titulo || !fecha) {
    if (req.file) fs.unlink(req.file.path, () => {});
    const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
    return res.status(400).render('admin/minuta-form', {
      title: 'Nueva minuta', active: 'minutas', minuta: null, empresas, proyectos: allProjects(), FORMATOS, error: 'Título y fecha son obligatorios.',
    });
  }

  // Multi-proyecto: si se eligió un proyecto, de él se derivan empresa y company_name
  let projectId = parseInt(req.body.project_id, 10) || null;
  let companyId = company_id || null;
  let cName = company_id
    ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(company_id) || {}).name || company_name
    : company_name;
  if (projectId) {
    const p = db.prepare(
      'SELECT p.id, p.company_id, c.name AS company_name FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.id = ?'
    ).get(projectId);
    if (p) { companyId = p.company_id; cName = p.company_name; }
    else projectId = null;
  }

  const archivoPath   = req.file ? req.file.filename : null;
  const archivoNombre = req.file ? req.file.originalname : null;

  const result = db.prepare(
    `INSERT INTO minutas (titulo, fecha, company_id, company_name, formato, transcripcion, archivo_path, archivo_nombre, created_by, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(titulo, fecha, companyId || null, cName || null, formato || 'ejecutiva',
        transcripcion || null, archivoPath, archivoNombre, req.session.userId, projectId);
  const id = result.lastInsertRowid;
  logAction(req.session.userId, 'minuta_created', titulo, req.ip);

  if (accion === 'generar' && transcripcion && transcripcion.trim()) {
    lanzarGeneracionIA(id, { titulo, fecha, company_name: cName, formato: formato || 'ejecutiva', transcripcion }, req.session.userId, req.ip);
    req.session.flash = { type: 'success', text: 'Minuta creada. Generando con IA… puede tardar 1–2 min en reuniones largas; la página se actualiza sola.' };
  } else {
    req.session.flash = { type: 'success', text: 'Minuta creada.' };
  }
  res.redirect(`/admin/minutas/${id}`);
});

// ── Descargar archivo adjunto ────────────────────────────────────────────────
router.get('/:id/descargar', (req, res) => {
  const m = db.prepare('SELECT archivo_path, archivo_nombre FROM minutas WHERE id = ?').get(req.params.id);
  if (!m || !m.archivo_path) return res.status(404).send('Archivo no encontrado.');
  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado en servidor.');
  res.download(filePath, m.archivo_nombre || m.archivo_path);
});

// ── Detalle de minuta ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).render('error', { title: 'No encontrado', message: 'Minuta no encontrada.' });
  const fmtObj = FORMATOS.find(f => f.id === m.formato) || FORMATOS[0];
  const generando = iaEnCurso.has(Number(m.id));
  const errorIA = iaError.get(Number(m.id)) || null;
  if (errorIA) iaError.delete(Number(m.id));
  res.render('admin/minuta-detalle', { title: m.titulo, active: 'minutas', m, fmtObj, FORMATOS, error: null, success: null, generando, errorIA });
});

// ── Guardar transcripción / contenido ──────────────────────────────────────
router.post('/:id/guardar', (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const { campo, valor } = req.body;
  if (!['transcripcion', 'contenido', 'titulo', 'formato'].includes(campo)) return res.redirect(`/admin/minutas/${req.params.id}`);
  db.prepare(`UPDATE minutas SET ${campo} = ? WHERE id = ?`).run(valor || '', req.params.id);
  req.session.flash = { type: 'success', text: 'Guardado correctamente.' };
  res.redirect(`/admin/minutas/${req.params.id}`);
});

// Estado en memoria de generaciones de IA en curso y último error por minuta
const iaEnCurso = new Set();
const iaError = new Map();

// Lanza la generación con IA en segundo plano: la petición HTTP responde de inmediato
function lanzarGeneracionIA(id, m, userId, ip) {
  id = Number(id);
  if (iaEnCurso.has(id)) return;
  iaEnCurso.add(id);
  iaError.delete(id);
  generarConGemini(id, m, { session: { userId }, ip })
    .catch((err) => { iaError.set(id, geminiErrorMsg(err)); console.error('[IA] minuta', id, '-', err && err.message); })
    .finally(() => iaEnCurso.delete(id));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function buildPrompt(m) {
  const prompts = {
    ejecutiva:
      `Eres un asistente experto en redacción de minutas corporativas. Genera una minuta EJECUTIVA en español. ` +
      `Incluye: encabezado con título "${m.titulo}", fecha ${m.fecha}, empresa ${m.company_name || ''}; ` +
      `resumen ejecutivo (3-5 puntos clave); acuerdos y compromisos con responsable y fecha; próximos pasos. ` +
      `Usa Markdown limpio con encabezados ##.`,
    detallada:
      `Eres un asistente experto en redacción de minutas corporativas. Genera una minuta DETALLADA en español. ` +
      `Incluye: encabezado con título "${m.titulo}", fecha ${m.fecha}, empresa ${m.company_name || ''}; ` +
      `lista de participantes mencionados; cada tema tratado con su discusión y resolución; ` +
      `tabla de compromisos con responsable, acción y fecha; próxima reunión si se menciona. ` +
      `Usa Markdown con ## y tablas donde aplique.`,
    acta_formal:
      `Eres un asistente experto en redacción de actas formales corporativas. Redacta un ACTA FORMAL en español. ` +
      `Incluye: encabezado formal con título "${m.titulo}", fecha ${m.fecha}, empresa ${m.company_name || ''}; ` +
      `participantes; objeto de la reunión; acuerdos en artículos numerados (PRIMERO, SEGUNDO…); ` +
      `sección de firmas. Usa Markdown.`,
  };
  return prompts[m.formato] || prompts.ejecutiva;
}

// Traduce errores de IA a un mensaje claro para el admin
function geminiErrorMsg(err) {
  const msg = (err && err.message) || String(err);
  if (/proveedor de IA configurado/.test(msg)) return 'No hay proveedor de IA configurado en el servidor.';
  if (/límite diario|per day|TPD/i.test(msg)) {
    const mm = msg.match(/reintenta en ([0-9hms.\s]+)/i) || msg.match(/try again in ([0-9hms.\s]+)/i);
    return 'Se alcanzó el límite diario gratuito de IA (Groq: 100,000 tokens/día).' + (mm ? ' Vuelve a intentar en ~' + mm[1].trim().replace(/\.\d+s/, 's') + '.' : ' Vuelve a intentar más tarde (se restablece cada día).');
  }
  if (/413|Request too large|tokens per minute|TPM/i.test(msg)) return 'La transcripción es muy larga para el plan gratuito. Intenta de nuevo (se procesa por partes) o reduce un poco el texto.';
  if (/429|quota|Too Many Requests|rate.?limit/i.test(msg)) return 'El servicio de IA está saturado por el límite por minuto. Espera un momento y reintenta.';
  if (/API key not valid|API_KEY_INVALID|invalid_api_key|401|403|PERMISSION/i.test(msg)) return 'La API key de IA no es válida o no tiene permisos.';
  if (/not found|404|is not supported|model_not_found|decommissioned/i.test(msg)) return 'El modelo de IA configurado no está disponible.';
  return msg.slice(0, 180);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quita marcas de tiempo y líneas vacías de una transcripción para ahorrar tokens
function cleanTranscript(t) {
  return String(t || '')
    // Líneas con rango de tiempo "HH:MM:SS <sep> HH:MM:SS" (cualquier separador)
    .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*[^\w\n]{0,3}\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/gm, '')
    // Líneas con un solo tiempo "[HH:MM:SS]"
    .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Divide un texto en trozos de ~maxChars, cortando en saltos de línea cuando se puede
function chunkText(t, maxChars) {
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + maxChars, t.length);
    if (end < t.length) {
      const nl = t.lastIndexOf('\n', end);
      if (nl > i + maxChars * 0.5) end = nl;
    }
    chunks.push(t.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}

// Llama a Groq (API compatible con OpenAI) con reintentos acotados ante 429.
// opts.deadline: timestamp límite global para abortar (evita que la tarea se cuelgue).
const MAX_WAIT_MS = 20000;   // nunca dormir más de 20s entre reintentos
const FETCH_TIMEOUT_MS = 70000; // timeout por petición (evita fetch colgado)
async function groqChat(prompt, maxTokens, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const deadline = opts.deadline || (Date.now() + 240000);
  let lastErr = 'desconocido';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (Date.now() > deadline) throw new Error('Groq timeout: la generación tardó demasiado (límite de tokens del plan gratuito).');
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature == null ? 0.4 : opts.temperature,
      max_tokens: maxTokens || 2500,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'tiempo de espera agotado' : ('red: ' + e.message);
      continue; // reintenta ante error de red / timeout
    } finally {
      clearTimeout(to);
    }
    if (resp.status === 429) {
      const bodyTxt = await resp.text().catch(() => '');
      const perDay = /per day|TPD/i.test(bodyTxt);
      const tryIn = (bodyTxt.match(/try again in ([0-9hms.\s]+)/i) || [])[1];
      const ra = parseFloat(resp.headers.get('retry-after') || '');
      const waitMs = Math.min(MAX_WAIT_MS, (Number.isFinite(ra) ? ra + 1 : 6) * 1000);
      lastErr = 'Groq 429' + (perDay ? ' [límite diario]' : ' [límite por minuto]') + (tryIn ? ' reintenta en ' + tryIn.trim() : '');
      // Si es el límite diario o no alcanzamos a esperar dentro del plazo, no insistas.
      if (perDay || Date.now() + waitMs > deadline) throw new Error(lastErr);
      await sleep(waitMs);
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('Groq ' + resp.status + ': ' + t.slice(0, 200));
    }
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
  throw new Error('Groq: no respondió tras varios intentos (' + lastErr + ').');
}

// Resume una transcripción larga a notas por partes (map). Si es corta, la devuelve tal cual.
async function extraerNotas(clean, deadline) {
  const CHUNK_SIZE = 24000; // ~6k tokens por parte (límite 12k TPM)
  if (clean.length <= 34000) return clean;
  const chunks = chunkText(clean, CHUNK_SIZE);
  const notas = [];
  for (let k = 0; k < chunks.length; k++) {
    notas.push(await groqChat(
      `Estás procesando la PARTE ${k + 1} de ${chunks.length} de la transcripción de una reunión. ` +
      `Extrae en español, en viñetas concisas: asistentes y roles, temas tratados, decisiones/acuerdos, ` +
      `compromisos/tareas (con responsable y fecha si se mencionan) y datos relevantes (cifras, fechas, nombres). ` +
      `No inventes nada. Devuelve solo viñetas.\n\n--- PARTE ${k + 1} ---\n${chunks[k]}`,
      900, { deadline }
    ));
  }
  return notas.join('\n\n');
}

// Construye los datos estructurados de la minuta (JSON) a partir de la transcripción.
async function construirDatosMinuta(m) {
  const deadline = Date.now() + 300000; // 5 min como máximo para toda la generación
  const clean = cleanTranscript(m.transcripcion);
  const fuente = await extraerNotas(clean, deadline);
  const esquema = `{
  "subtitulo": "subtitulo breve de la sesion (string, opcional)",
  "meta": { "proyecto":"", "no_minuta":"", "horario":"", "modalidad":"", "tipo_sesion":"" },
  "asistentes": { "businesscool":[{"nombre":"","rol":""}], "cliente":[{"nombre":"","rol":""}] },
  "secciones": [ {"titulo":"Objetivo de la sesion","parrafos":["..."],"vinetas":["..."]} ],
  "acuerdos": ["..."],
  "tareas": [ {"id":"BC-1 o PK-1","tarea":"","responsable":"","fecha":"","parte":"businesscool|cliente"} ],
  "firmas": { "businesscool":{"nombre":"","rol":""}, "cliente":{"nombre":"","rol":""} }
}`;
  const prompt =
    `Eres un asistente experto en actas y minutas corporativas. A partir de las NOTAS de una reunión, ` +
    `genera la minuta en formato JSON (responde SOLO con JSON válido, en español) siguiendo EXACTAMENTE este esquema:\n${esquema}\n\n` +
    `Reglas:\n` +
    `- No inventes datos; si algo no aparece, deja el campo como "" o el arreglo vacío [].\n` +
    `- "meta": llena proyecto, no_minuta, horario, modalidad y tipo_sesion SOLO si se mencionan explícitamente. NUNCA uses la fecha como horario ni el título como no_minuta; si no hay dato, deja "".\n` +
    `- "secciones": incluye las que apliquen (Objetivo, Vision general, Metodologia, Fases del proyecto, Gobernanza y comunicacion, etc.). Cada seccion usa "parrafos" y/o "vinetas".\n` +
    `- "tareas": clasifica cada compromiso en "businesscool" o "cliente" segun el responsable; usa IDs BC-1, BC-2… y PK-1, PK-2…\n` +
    `- "firmas": el firmante por BusinessCool AI suele ser quien dirige el proyecto; por el cliente, su lider/contacto.\n` +
    `- Titulo "${m.titulo || ''}", fecha "${m.fecha || ''}", empresa "${m.company_name || ''}".\n\n` +
    `NOTAS DE LA REUNIÓN:\n${fuente}`;
  const raw = await groqChat(prompt, 4000, { json: true, temperature: 0.3, deadline });
  try {
    return JSON.parse(raw);
  } catch (_) {
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(raw.slice(a, b + 1));
    throw new Error('La IA no devolvió un JSON válido para la minuta.');
  }
}

// IA con Gemini (Google) — requiere cuota/facturación en la cuenta
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// Genera la minuta con IA y la guarda como PDF con el formato corporativo (firmable).
async function generarConGemini(id, m, req) {
  if (!process.env.GROQ_API_KEY) {
    // Respaldo: Gemini en texto (no produce PDF; requiere cuota, normalmente no disponible)
    if (!process.env.GEMINI_API_KEY) throw new Error('No hay proveedor de IA configurado (GROQ_API_KEY o GEMINI_API_KEY).');
    const contenido = await callGemini(buildPrompt(m) + `\n\nTRANSCRIPCIÓN / DESCRIPCIÓN DE LA REUNIÓN:\n${m.transcripcion}`);
    db.prepare('UPDATE minutas SET contenido = ? WHERE id = ?').run(contenido, id);
    if (req && req.session) logAction(req.session.userId, 'minuta_generated_gemini', m.titulo, req.ip);
    return;
  }
  const data = await construirDatosMinuta(m);
  const pdfBytes = await renderMinutaPDF(m, data);
  const filename = `minuta-${id}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(MINUTAS_DIR, filename), pdfBytes);
  const nombre = `Minuta - ${(m.titulo || 'minuta').replace(/[^\w\sáéíóúñÁÉÍÓÚÑ.-]/g, '').trim()}.pdf`;
  db.prepare('UPDATE minutas SET archivo_path = ?, archivo_nombre = ?, contenido = ? WHERE id = ?')
    .run(filename, nombre, JSON.stringify(data), id);
  if (req && req.session) logAction(req.session.userId, 'minuta_generated_groq_pdf', m.titulo, req.ip);
}

// ── Generar minuta con IA ──────────────────────────────────────────────────
router.post('/:id/generar', async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin/minutas');

  if (!m.transcripcion || !m.transcripcion.trim()) {
    req.session.flash = { type: 'error', text: 'Agrega la transcripción antes de generar.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }

  lanzarGeneracionIA(m.id, m, req.session.userId, req.ip);
  req.session.flash = { type: 'success', text: 'Generando la minuta con IA… puede tardar 1–2 min en reuniones largas; la página se actualiza sola.' };
  res.redirect(`/admin/minutas/${m.id}`);
});

// ── Servir PDF inline (vista previa) ─────────────────────────────────────
router.get('/:id/ver-pdf', (req, res) => {
  const m = db.prepare('SELECT archivo_path, archivo_nombre FROM minutas WHERE id = ?').get(req.params.id);
  if (!m || !m.archivo_path) return res.status(404).send('Sin archivo');
  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado');
  // Eliminar cabeceras que bloquean embedding de PDF en iframe/object
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="minuta.pdf"');
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(filePath).pipe(res);
});

// ── Firmar con e.firma (SAT) ───────────────────────────────────────────────
router.post('/:id/firmar', memUpload.fields([{ name: 'key_file', maxCount: 1 }, { name: 'cer_file', maxCount: 1 }]), async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin/minutas');

  const keyFile    = req.files && req.files['key_file'] && req.files['key_file'][0];
  const cerFile    = req.files && req.files['cer_file'] && req.files['cer_file'][0];
  const passphrase = String(req.body.passphrase || '');

  if (!keyFile || !cerFile || !passphrase) {
    req.session.flash = { type: 'error', text: 'Sube los archivos .key y .cer e ingresa la contraseña.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }

  try {
    if (m.archivo_path) {
      // PDF adjunto: la firma se coloca automáticamente sobre el apartado del firmante
      const result = await firmarPDF(m.id, m, keyFile.buffer, cerFile.buffer, passphrase, req.session.userId, req.ip);
      req.session.flash = { type: 'success', text: `PDF firmado electrónicamente. Folio: ${result.folio}` };
    } else {
      // Minuta de texto: firmar el contenido y anotar al final
      if (!m.contenido) {
        req.session.flash = { type: 'error', text: 'Genera o escribe el contenido antes de firmar.' };
        return res.redirect(`/admin/minutas/${m.id}`);
      }
      const b64Key = keyFile.buffer.toString('base64');
      const pemKey = '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' +
                     b64Key.match(/.{1,64}/g).join('\n') +
                     '\n-----END ENCRYPTED PRIVATE KEY-----';
      const privKey = forge.pki.decryptRsaPrivateKey(pemKey, passphrase);
      if (!privKey) throw new Error('Contraseña incorrecta o archivo .key inválido.');
      const b64Cer = cerFile.buffer.toString('base64');
      const pemCer = '-----BEGIN CERTIFICATE-----\n' + b64Cer.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
      const cert   = forge.pki.certificateFromPem(pemCer);
      const serial = cert.serialNumber.replace(/^0+/, '');
      const cn     = (cert.subject.getField('CN') || {}).value || 'Desconocido';
      const md     = forge.md.sha256.create();
      md.update(m.contenido, 'utf8');
      const sig  = forge.util.encode64(privKey.sign(md));
      const now  = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare('UPDATE minutas SET firmada=1, firma_serial=?, firma_nombre=?, firma_fecha=? WHERE id=?').run(serial, cn, now, m.id);
      db.prepare('UPDATE minutas SET contenido = contenido || ? WHERE id=?').run(
        `\n\n---\n**Firmado electronicamente**\n- Nombre: ${cn}\n- No. serie: ${serial}\n- Fecha: ${now}\n- Sello: ${sig.slice(0, 64)}...`, m.id);
      logAction(req.session.userId, 'minuta_signed', `${m.titulo} · ${serial}`, req.ip);
      req.session.flash = { type: 'success', text: `Minuta firmada con la e.firma de ${cn}.` };
    }
  } catch (err) {
    req.session.flash = { type: 'error', text: 'Error al firmar: ' + err.message };
  }
  res.redirect(`/admin/minutas/${m.id}`);
});

// ── Publicar al cliente ────────────────────────────────────────────────────
router.post('/:id/publicar', (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin/minutas');
  db.prepare('UPDATE minutas SET publicada = ? WHERE id = ?').run(m.publicada ? 0 : 1, m.id);
  req.session.flash = { type: 'success', text: m.publicada ? 'Envío retirado: el cliente ya no la verá.' : 'Minuta enviada al cliente responsable.' };
  res.redirect('/admin/minutas');
});

// ── Eliminar minuta ────────────────────────────────────────────────────────
router.post('/:id/eliminar', (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  db.prepare('DELETE FROM minutas WHERE id = ?').run(req.params.id);
  req.session.flash = { type: 'success', text: 'Minuta eliminada.' };
  res.redirect('/admin/minutas');
});

module.exports = router;
