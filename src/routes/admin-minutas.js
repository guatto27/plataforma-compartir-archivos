'use strict';

const express = require('express');
const multer  = require('multer');
const forge   = require('node-forge');

const { db, logAction } = require('../db');
const { requireLogin, requireRole, verifyCsrf, denyCsrf } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireRole('admin', 'colaborador'));

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
  const minutas = db.prepare(
    `SELECT m.*, u.display_name AS autor_nombre
     FROM minutas m LEFT JOIN users u ON u.id = m.created_by
     ORDER BY m.fecha DESC, m.created_at DESC`
  ).all();
  const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  res.render('admin/minutas', { title: 'Minutas', active: 'minutas', minutas, empresas, FORMATOS });
});

// ── Nueva minuta ────────────────────────────────────────────────────────────
router.get('/nueva', (req, res) => {
  const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  res.render('admin/minuta-form', { title: 'Nueva minuta', active: 'minutas', minuta: null, empresas, FORMATOS, error: null });
});

router.post('/nueva', (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const { titulo, fecha, company_id, company_name, formato } = req.body;
  if (!titulo || !fecha) {
    const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
    return res.status(400).render('admin/minuta-form', {
      title: 'Nueva minuta', active: 'minutas', minuta: null, empresas, FORMATOS, error: 'Título y fecha son obligatorios.',
    });
  }
  const cName = company_id
    ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(company_id) || {}).name || company_name
    : company_name;
  const result = db.prepare(
    `INSERT INTO minutas (titulo, fecha, company_id, company_name, formato, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(titulo, fecha, company_id || null, cName || null, formato || 'ejecutiva', req.session.userId);
  logAction(req.session.userId, 'minuta_created', titulo, req.ip);
  res.redirect(`/admin/minutas/${result.lastInsertRowid}`);
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

// ── Generar minuta con IA ──────────────────────────────────────────────────
router.post('/:id/generar', async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin/minutas');

  if (!m.transcripcion || !m.transcripcion.trim()) {
    req.session.flash = { type: 'error', text: 'Agrega la transcripción antes de generar.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    req.session.flash = { type: 'error', text: 'ANTHROPIC_API_KEY no configurado en el servidor.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }

  const fmtLabel = (FORMATOS.find(f => f.id === m.formato) || FORMATOS[0]).label;
  const prompts = {
    ejecutiva: `Genera una minuta ejecutiva en español a partir de la siguiente transcripción. Incluye: fecha (${m.fecha}), empresa (${m.company_name || ''}), resumen ejecutivo en 3-5 puntos clave, acuerdos tomados con responsables y fechas comprometidas. Usa formato Markdown limpio con encabezados ##.`,
    detallada: `Genera una minuta detallada en español. Incluye: fecha (${m.fecha}), empresa (${m.company_name || ''}), lista de participantes mencionados, cada tema tratado con su discusión y resolución, compromisos y responsables, y próxima reunión si se menciona. Usa Markdown con ## y tablas donde aplique.`,
    acta_formal: `Redacta un acta formal en español con numeración de artículos (Primero, Segundo…). Incluye: encabezado formal con fecha (${m.fecha}), empresa (${m.company_name || ''}), participantes, objeto de la reunión, acuerdos en forma de artículos numerados, y sección de firmas al final. Usa Markdown.`,
  };
  const systemPrompt = prompts[m.formato] || prompts.ejecutiva;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `${systemPrompt}\n\nTRANSCRIPCIÓN:\n${m.transcripcion}` }],
    });
    const contenido = msg.content[0].text;
    db.prepare('UPDATE minutas SET contenido = ? WHERE id = ?').run(contenido, m.id);
    logAction(req.session.userId, 'minuta_generated', m.titulo, req.ip);
    req.session.flash = { type: 'success', text: 'Minuta generada con IA correctamente.' };
  } catch (err) {
    req.session.flash = { type: 'error', text: 'Error al generar: ' + err.message };
  }
  res.redirect(`/admin/minutas/${m.id}`);
});

// ── Firmar con e.firma (SAT) ───────────────────────────────────────────────
router.post('/:id/firmar', memUpload.fields([{ name: 'key_file', maxCount: 1 }, { name: 'cer_file', maxCount: 1 }]), (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin/minutas');

  const keyBuf = req.files && req.files['key_file'] && req.files['key_file'][0];
  const cerBuf = req.files && req.files['cer_file'] && req.files['cer_file'][0];
  const passphrase = String(req.body.passphrase || '');

  if (!keyBuf || !cerBuf || !passphrase) {
    req.session.flash = { type: 'error', text: 'Sube los archivos .key y .cer e ingresa la contraseña.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }
  if (!m.contenido) {
    req.session.flash = { type: 'error', text: 'Genera o escribe el contenido de la minuta antes de firmar.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }

  try {
    // Cargar llave privada SAT (DER cifrado → PEM con node-forge)
    const keyDer  = forge.util.createBuffer(keyBuf.buffer.toString('binary'));
    const keyAsn1 = forge.asn1.fromDer(keyDer);
    const encKey  = forge.pki.encryptedPrivateKeyFromAsn1(keyAsn1);
    const keyPem  = forge.pki.decryptRsaPrivateKey(encKey, passphrase);
    if (!keyPem) throw new Error('Contraseña incorrecta o archivo .key inválido.');

    // Leer certificado SAT (DER → cert)
    const cerDer  = forge.util.createBuffer(cerBuf.buffer.toString('binary'));
    const cerAsn1 = forge.asn1.fromDer(cerDer);
    const cert    = forge.pki.certificateFromAsn1(cerAsn1);
    const serial  = cert.serialNumber;
    const subject = cert.subject.getField('CN') ? cert.subject.getField('CN').value : 'Desconocido';

    // Firmar el contenido con SHA-256
    const md = forge.md.sha256.create();
    md.update(m.contenido, 'utf8');
    const signature = forge.util.encode64(keyPem.sign(md));

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      `UPDATE minutas SET firmada = 1, firma_serial = ?, firma_nombre = ?, firma_fecha = ? WHERE id = ?`
    ).run(serial, subject, now, m.id);
    // Guardar firma en tabla separada o en el propio registro (simplified: guardamos en contenido + sello)
    db.prepare(`UPDATE minutas SET contenido = contenido || ? WHERE id = ?`).run(
      `\n\n---\n**Firmado electrónicamente**\n- Nombre: ${subject}\n- No. serie: ${serial}\n- Fecha: ${now}\n- Algoritmo: RSA-SHA256\n- Sello: ${signature.slice(0, 64)}…`,
      m.id
    );
    logAction(req.session.userId, 'minuta_signed', `${m.titulo} · ${serial}`, req.ip);
    req.session.flash = { type: 'success', text: `Minuta firmada correctamente con la e.firma de ${subject}.` };
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
  req.session.flash = { type: 'success', text: m.publicada ? 'Minuta despublicada.' : 'Minuta publicada al cliente.' };
  res.redirect(`/admin/minutas/${m.id}`);
});

// ── Eliminar minuta ────────────────────────────────────────────────────────
router.post('/:id/eliminar', (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  db.prepare('DELETE FROM minutas WHERE id = ?').run(req.params.id);
  req.session.flash = { type: 'success', text: 'Minuta eliminada.' };
  res.redirect('/admin/minutas');
});

module.exports = router;
