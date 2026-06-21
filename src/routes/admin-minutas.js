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
  res.render('admin/minutas', { title: 'Minutas', active: 'minutas', minutas, empresas, FORMATOS, projectFilter });
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
    await generarConGemini(id, { titulo, fecha, company_name: cName, formato: formato || 'ejecutiva', transcripcion }, req);
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
  res.render('admin/minuta-detalle', { title: m.titulo, active: 'minutas', m, fmtObj, FORMATOS, error: null, success: null });
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

async function generarConGemini(id, m, req) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurado en el servidor.');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const prompt = buildPrompt(m) + `\n\nTRANSCRIPCIÓN / DESCRIPCIÓN DE LA REUNIÓN:\n${m.transcripcion}`;
  const result = await model.generateContent(prompt);
  const contenido = result.response.text();
  db.prepare('UPDATE minutas SET contenido = ? WHERE id = ?').run(contenido, id);
  if (req && req.session) logAction(req.session.userId, 'minuta_generated_gemini', m.titulo, req.ip);
  return contenido;
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

  try {
    await generarConGemini(m.id, m, req);
    req.session.flash = { type: 'success', text: 'Minuta generada con Gemini correctamente.' };
  } catch (err) {
    req.session.flash = { type: 'error', text: 'Error al generar: ' + err.message };
  }
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
