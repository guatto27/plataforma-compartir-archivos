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

const router = express.Router();
router.use(requireLogin, requireRole('admin', 'colaborador'));

// Directorio para minutas subidas como archivo
const MINUTAS_DIR = path.join(config.uploadsDir, 'minutas');
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

router.post('/nueva', minutaUpload.single('archivo'), async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const { titulo, fecha, company_id, company_name, formato, transcripcion, accion } = req.body;
  if (!titulo || !fecha) {
    if (req.file) fs.unlink(req.file.path, () => {});
    const empresas = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
    return res.status(400).render('admin/minuta-form', {
      title: 'Nueva minuta', active: 'minutas', minuta: null, empresas, FORMATOS, error: 'Título y fecha son obligatorios.',
    });
  }
  const cName = company_id
    ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(company_id) || {}).name || company_name
    : company_name;

  const archivoPath   = req.file ? req.file.filename : null;
  const archivoNombre = req.file ? req.file.originalname : null;

  const result = db.prepare(
    `INSERT INTO minutas (titulo, fecha, company_id, company_name, formato, transcripcion, archivo_path, archivo_nombre, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(titulo, fecha, company_id || null, cName || null, formato || 'ejecutiva',
        transcripcion || null, archivoPath, archivoNombre, req.session.userId);
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

// ── Firma PDF con e.firma SAT (añade página de firma al PDF) ───────────────
async function firmarPDF(minutaId, m, keyBuf, cerBuf, passphrase) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  // Parsear certificado SAT
  const cerDer  = forge.util.createBuffer(cerBuf.toString('binary'));
  const cert    = forge.pki.certificateFromAsn1(forge.asn1.fromDer(cerDer));
  const serial  = cert.serialNumber.replace(/^0+/, '');
  const cn      = cert.subject.getField('CN') ? cert.subject.getField('CN').value : '';
  const ouField = cert.subject.getField('OU');
  const cnAC    = ouField ? ouField.value : 'AC DEL SERVICIO DE ADMINISTRACION TRIBUTARIA';
  const emailF  = cert.subject.getField('E') || cert.subject.getField('1.2.840.113549.1.9.1');
  const email   = emailF ? emailF.value : '';
  const rfcM    = cn.match(/([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
  const rfc     = rfcM ? rfcM[1].toUpperCase() : '';
  const nomM    = cn.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\s*\/?\s*(.+)/i);
  const nombre  = nomM ? nomM[1].trim() : cn;

  // Descifrar llave privada: convertir DER → PEM y usar decryptRsaPrivateKey
  const b64Key  = keyBuf.toString('base64');
  const pemKey  = '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' +
                  b64Key.match(/.{1,64}/g).join('\n') +
                  '\n-----END ENCRYPTED PRIVATE KEY-----';
  const privKey = forge.pki.decryptRsaPrivateKey(pemKey, passphrase);
  if (!privKey) throw new Error('Contraseña incorrecta o archivo .key inválido.');

  // Leer y firmar el PDF
  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  const pdfBytes = fs.readFileSync(filePath);
  const md = forge.md.sha256.create();
  md.update(pdfBytes.toString('binary'));
  const sigB64 = forge.util.encode64(privKey.sign(md));

  // Generar folio y clave
  const folio = crypto.randomUUID();
  const clave = String(minutaId).padStart(5, '0');
  const ahora = new Date();
  const fechaFirma = ahora.toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // Cargar PDF con pdf-lib
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Añadir footer con Clave/Folio a todas las páginas existentes
  const footerTxt = `Clave: ${clave}  Folio: ${folio}`;
  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    page.drawLine({ start: { x: 28, y: 26 }, end: { x: width - 28, y: 26 }, thickness: 0.4, color: rgb(0.65, 0.65, 0.65) });
    page.drawText(footerTxt, { x: 28, y: 14, size: 6.5, font, color: rgb(0.42, 0.42, 0.42) });
  }

  // Generar QR apuntando a la URL de verificación
  const qrBuf = await QRCode.toBuffer(`https://proyectos.businesscool.ai/verificar/${folio}`,
    { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  // ── Página de firma (A4 portrait: 595 × 842 pt) ──────────────────────────
  const W = 595.28, H = 841.89, MX = 36;
  const sp = pdfDoc.addPage([W, H]);
  let y = H - MX;

  // Borde exterior
  sp.drawRectangle({ x: MX - 6, y: MX - 6, width: W - 2*(MX-6), height: H - 2*(MX-6),
    color: rgb(1,1,1), borderColor: rgb(0.76,0.76,0.82), borderWidth: 0.8 });

  // Barra de título oscura
  sp.drawRectangle({ x: MX-6, y: y-30, width: W-2*(MX-6), height: 30, color: rgb(0.10,0.13,0.21) });
  sp.drawText('FIRMA ELECTRONICA DE DOCUMENTOS', { x: MX+2, y: y-21, size: 10, font: fontB, color: rgb(0.98,0.98,0.98) });
  sp.drawText('BusinessCool AI', { x: W-MX-95, y: y-21, size: 9, font: fontB, color: rgb(0.98,0.75,0.14) });
  y -= 42;

  // ── DATOS DEL FIRMANTE ──
  sp.drawText('DATOS DEL FIRMANTE', { x: MX, y, size: 7.5, font: fontB, color: rgb(0.22,0.22,0.38) });
  y -= 4;
  sp.drawLine({ start: { x: MX, y }, end: { x: W-MX, y }, thickness: 0.5, color: rgb(0.76,0.76,0.85) });
  y -= 3;

  const dataRows = [
    ['RFC', rfc],
    ['Nombre', nombre],
    ['No. Certificado', serial],
    ['CN', cnAC],
    ['Folio', folio],
    ['Correo electronico', email],
  ];
  const boxH = dataRows.length * 16 + 14;
  sp.drawRectangle({ x: MX-4, y: y-boxH, width: W-2*MX+8, height: boxH,
    color: rgb(0.95,0.95,0.97), borderColor: rgb(0.80,0.80,0.88), borderWidth: 0.5 });
  let ry = y - 11;
  for (const [lbl, val] of dataRows) {
    sp.drawText(`${lbl}:`, { x: MX+4, y: ry, size: 7, font: fontB, color: rgb(0.18,0.18,0.32) });
    // Truncar valores muy largos para que quepan en la línea
    const maxVal = Math.floor((W - MX - 120) / 3.5);
    const valStr = (val || '').length > maxVal ? (val || '').slice(0, maxVal) + '...' : (val || '');
    sp.drawText(valStr, { x: MX+108, y: ry, size: 7, font, color: rgb(0.08,0.08,0.22) });
    ry -= 16;
  }
  y -= boxH + 14;

  // ── FIRMA ELECTRONICA AVANZADA ──
  sp.drawText('FIRMA ELECTRONICA AVANZADA', { x: MX, y, size: 7.5, font: fontB, color: rgb(0.22,0.22,0.38) });
  y -= 4;
  sp.drawLine({ start: { x: MX, y }, end: { x: W-MX, y }, thickness: 0.5, color: rgb(0.76,0.76,0.85) });
  y -= 3;

  const sigLines = [];
  for (let i = 0; i < sigB64.length; i += 94) sigLines.push(sigB64.slice(i, i+94));
  const sigBoxH = Math.min(sigLines.length, 11) * 10 + 14;
  sp.drawRectangle({ x: MX-4, y: y-sigBoxH, width: W-2*MX+8, height: sigBoxH,
    color: rgb(0.95,0.95,0.97), borderColor: rgb(0.80,0.80,0.88), borderWidth: 0.5 });
  let sy = y - 11;
  for (const line of sigLines.slice(0, 11)) {
    sp.drawText(line, { x: MX+4, y: sy, size: 6.5, font, color: rgb(0.14,0.14,0.26) });
    sy -= 10;
  }
  y -= sigBoxH + 14;

  // ── QR + texto legal ──
  const qrSize = 88;
  sp.drawImage(qrImg, { x: MX+4, y: y - qrSize, width: qrSize, height: qrSize });
  sp.drawText('Verificar autenticidad:', { x: MX+4, y: y-qrSize-10, size: 6, font: fontB, color: rgb(0.38,0.38,0.48) });
  sp.drawText(`/verificar/${folio.slice(0,18)}...`, { x: MX+4, y: y-qrSize-19, size: 5.5, font, color: rgb(0.45,0.45,0.55) });

  const legalX = MX + qrSize + 16;
  const legalW = W - MX - qrSize - 20;
  const legalTxt =
    `Este documento electronico ha sido firmado de forma electronica con el certificado de ` +
    `e.firma (FIEL) emitido por el Servicio de Administracion Tributaria (SAT) con numero de ` +
    `serie ${serial}, cuya vigencia es anterior a la fecha de la firma. El proceso de firma ` +
    `tiene validez juridica conforme a la Ley de Firma Electronica Avanzada (DOF 11-01-2012), ` +
    `el Codigo de Comercio articulos 89 al 94, y el Codigo Civil Federal articulo 1803. ` +
    `La integridad y autoria de este documento puede verificarse en ` +
    `proyectos.businesscool.ai/verificar/${folio}. ` +
    `Fecha de firma: ${fechaFirma}.`;

  const chpl = Math.floor(legalW / 3.38);
  const words = legalTxt.split(' ');
  let curLine = '', legalY = y - 9;
  for (const w of words) {
    const cand = curLine ? `${curLine} ${w}` : w;
    if (cand.length > chpl) {
      sp.drawText(curLine, { x: legalX, y: legalY, size: 6.5, font, color: rgb(0.28,0.28,0.36) });
      legalY -= 9;
      curLine = w;
    } else { curLine = cand; }
  }
  if (curLine) sp.drawText(curLine, { x: legalX, y: legalY, size: 6.5, font, color: rgb(0.28,0.28,0.36) });

  // Footer de la página de firma
  sp.drawLine({ start: { x: MX-6, y: MX+18 }, end: { x: W-MX+6, y: MX+18 }, thickness: 0.4, color: rgb(0.65,0.65,0.65) });
  sp.drawText(footerTxt, { x: MX, y: MX+7, size: 7, font, color: rgb(0.42,0.42,0.42) });
  sp.drawText(fechaFirma, { x: W-MX-125, y: MX+7, size: 7, font, color: rgb(0.42,0.42,0.42) });

  // Guardar PDF firmado
  const signedBytes   = await pdfDoc.save();
  const ext           = path.extname(m.archivo_path);
  const signedFilename = path.basename(m.archivo_path, ext) + '_firmado' + ext;
  fs.writeFileSync(path.join(MINUTAS_DIR, signedFilename), signedBytes);

  const extO          = path.extname(m.archivo_nombre || 'minuta.pdf');
  const signedNombre  = path.basename(m.archivo_nombre || 'minuta.pdf', extO) + '_firmado' + extO;
  const nowISO        = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`UPDATE minutas SET firmada=1, firma_serial=?, firma_nombre=?, firma_fecha=?, archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(serial, nombre || cn, nowISO, signedFilename, signedNombre, minutaId);

  return { folio, clave, rfc, nombre, serial, fechaFirma };
}

// ── Firmar con e.firma (SAT) ───────────────────────────────────────────────
router.post('/:id/firmar', memUpload.fields([{ name: 'key_file', maxCount: 1 }, { name: 'cer_file', maxCount: 1 }]), async (req, res) => {
  if (!verifyCsrf(req)) return denyCsrf(res);
  const m = db.prepare('SELECT * FROM minutas WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin/minutas');

  const keyBuf     = req.files && req.files['key_file'] && req.files['key_file'][0];
  const cerBuf     = req.files && req.files['cer_file'] && req.files['cer_file'][0];
  const passphrase = String(req.body.passphrase || '');

  if (!keyBuf || !cerBuf || !passphrase) {
    req.session.flash = { type: 'error', text: 'Sube los archivos .key y .cer e ingresa la contraseña.' };
    return res.redirect(`/admin/minutas/${m.id}`);
  }

  try {
    if (m.archivo_path) {
      // PDF adjunto: añadir página de firma electrónica al PDF
      const result = await firmarPDF(m.id, m, keyBuf.buffer, cerBuf.buffer, passphrase);
      logAction(req.session.userId, 'minuta_pdf_signed', `${m.titulo} · ${result.serial}`, req.ip);
      req.session.flash = { type: 'success', text: `PDF firmado. Se añadió la página de firma electrónica. Folio: ${result.folio}` };
    } else {
      // Minuta de texto: firmar el contenido y anotar al final
      if (!m.contenido) {
        req.session.flash = { type: 'error', text: 'Genera o escribe el contenido antes de firmar.' };
        return res.redirect(`/admin/minutas/${m.id}`);
      }
      const b64Key2 = keyBuf.buffer.toString('base64');
      const pemKey2 = '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' +
                      b64Key2.match(/.{1,64}/g).join('\n') +
                      '\n-----END ENCRYPTED PRIVATE KEY-----';
      const keyPem  = forge.pki.decryptRsaPrivateKey(pemKey2, passphrase);
      if (!keyPem) throw new Error('Contraseña incorrecta o archivo .key inválido.');
      const cerDer  = forge.util.createBuffer(cerBuf.buffer.toString('binary'));
      const cert    = forge.pki.certificateFromAsn1(forge.asn1.fromDer(cerDer));
      const serial  = cert.serialNumber;
      const subject = cert.subject.getField('CN') ? cert.subject.getField('CN').value : 'Desconocido';
      const md      = forge.md.sha256.create();
      md.update(m.contenido, 'utf8');
      const signature = forge.util.encode64(keyPem.sign(md));
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`UPDATE minutas SET firmada=1, firma_serial=?, firma_nombre=?, firma_fecha=? WHERE id=?`).run(serial, subject, now, m.id);
      db.prepare(`UPDATE minutas SET contenido = contenido || ? WHERE id=?`).run(
        `\n\n---\n**Firmado electronicamente**\n- Nombre: ${subject}\n- No. serie: ${serial}\n- Fecha: ${now}\n- Sello: ${signature.slice(0, 64)}...`, m.id);
      logAction(req.session.userId, 'minuta_signed', `${m.titulo} · ${serial}`, req.ip);
      req.session.flash = { type: 'success', text: `Minuta firmada con la e.firma de ${subject}.` };
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
