'use strict';

const forge  = require('node-forge');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const config = require('../config');
const { db, logAction } = require('../db');

const MINUTAS_DIR = path.join(config.uploadsDir, 'minutas');
if (!fs.existsSync(MINUTAS_DIR)) fs.mkdirSync(MINUTAS_DIR, { recursive: true });

const CONTRATOS_DIR = path.join(config.uploadsDir, 'contratos');
if (!fs.existsSync(CONTRATOS_DIR)) fs.mkdirSync(CONTRATOS_DIR, { recursive: true });
exports.CONTRATOS_DIR = CONTRATOS_DIR;

const VERIFY_BASE = 'https://proyectos.businesscool.ai/verificar';

// Dimensiones del bloque de firma en puntos PDF (deben coincidir con
// BLOCK_W / BLOCK_H de public/js/firma-placer.js para que el recuadro del
// colocador tenga el mismo tamaño que el bloque final).
const BLOCK_W = 290, BLOCK_H = 112;

exports.MINUTAS_DIR = MINUTAS_DIR;

// ── Parsear certificado SAT (.cer DER → datos del firmante) ──────────────────
function parseCert(cerBuf) {
  const b64 = cerBuf.toString('base64');
  const pem = '-----BEGIN CERTIFICATE-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
  const cert = forge.pki.certificateFromPem(pem);

  // El SAT codifica el número de serie como texto ASCII (20 dígitos). node-forge
  // lo entrega en hexadecimal (el doble de largo); lo decodificamos al real.
  let serial = (cert.serialNumber || '').replace(/^0+/, '');
  try {
    const dec = Buffer.from(cert.serialNumber, 'hex').toString('latin1');
    if (/^[0-9]{12,}$/.test(dec)) serial = dec; // p. ej. 00001000000702466061
  } catch (_) { /* deja el hex si no decodifica */ }

  // getField acepta shortName (string) u {type:OID} / {name:'...'}; probamos varias formas.
  const field = (sel) => { const f = cert.subject.getField(sel); return f ? f.value : ''; };
  const cn = field('CN') || field({ name: 'commonName' }) || '';

  // RFC: en e.firma SAT vive en x500UniqueIdentifier (2.5.4.45) o en el atributo
  // serialNumber del subject (2.5.4.5), como "RFC / CURP".
  const RFC_RE = /([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i;
  let rfc = '';
  for (const cand of [field({ type: '2.5.4.45' }), field({ type: '2.5.4.5' }), field({ name: 'serialNumber' }), cn, field('OU')]) {
    const mm = String(cand || '').match(RFC_RE);
    if (mm) { rfc = mm[1].toUpperCase(); break; }
  }

  // Correo: atributo emailAddress del subject o, si no, el subjectAltName.
  let email = field({ name: 'emailAddress' }) || field('E') || field({ type: '1.2.840.113549.1.9.1' }) || '';
  if (!email) {
    try {
      const ext = cert.getExtension('subjectAltName');
      if (ext && ext.altNames) {
        const e = ext.altNames.find((a) => a.type === 1 && a.value); // rfc822Name
        if (e) email = e.value;
      }
    } catch (_) { /* sin SAN */ }
  }

  // Nombre legible
  const nomM = cn.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\s*\/?\s*(.+)/i);
  const nombre = nomM ? nomM[1].trim() : cn;

  return { serial, cn, email, rfc, nombre };
}
exports.parseCert = parseCert;

// ── Descifrar llave privada SAT (.key DER → clave privada) ───────────────────
function decryptKey(keyBuf, passphrase) {
  const b64 = keyBuf.toString('base64');
  const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END ENCRYPTED PRIVATE KEY-----';
  const key = forge.pki.decryptRsaPrivateKey(pem, passphrase);
  if (!key) throw new Error('Contraseña incorrecta o archivo .key inválido.');
  return key;
}

const fechaMX = () => new Date().toLocaleString('es-MX', {
  timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// ── Sello criptográfico e integridad ─────────────────────────────────────────
// Convierte el .cer (DER) a PEM para poder guardarlo y verificar el sello luego.
function cerToPem(cerBuf) {
  return '-----BEGIN CERTIFICATE-----\n' + cerBuf.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
}

const sha256Hex = (bytes) => {
  const md = forge.md.sha256.create();
  md.update(Buffer.from(bytes).toString('latin1'));
  return md.digest().toHex();
};

// Sella los bytes finales del PDF: devuelve el hash SHA-256 (hex) y el sello
// (firma RSA del hash con la llave privada del firmante), en base64.
function sellarBytes(privKey, bytes) {
  const mkMd = () => { const md = forge.md.sha256.create(); md.update(Buffer.from(bytes).toString('latin1')); return md; };
  return { hashHex: mkMd().digest().toHex(), sello: forge.util.encode64(privKey.sign(mkMd())) };
}

// Verifica un sello: el certificado (PEM) prueba que el titular de la e.firma
// selló exactamente ese hash. Devuelve true/false, o null si faltan datos.
function verificarSello(hashHex, selloB64, certPem) {
  if (!hashHex || !selloB64 || !certPem) return null;
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    return cert.publicKey.verify(forge.util.hexToBytes(hashHex), forge.util.decode64(selloB64));
  } catch (_) { return false; }
}

// Verifica un PDF subido contra lo registrado para esa minuta.
function verificarDocumento(m, uploadedBuf) {
  const upHex = sha256Hex(uploadedBuf);
  const authHash = m.firmada_cliente ? m.firma_cliente_hash : m.firma_hash;
  let integrity = 'unknown';
  if (authHash) integrity = (upHex === authHash) ? 'ok' : 'fail';

  const signers = [];
  if (m.firmada) signers.push({
    rol: 'BusinessCool AI', nombre: m.firma_nombre, rfc: m.firma_rfc, serial: m.firma_serial,
    fecha: m.firma_fecha, folio: m.firma_folio, email: m.firma_email,
    selloValido: verificarSello(m.firma_hash, m.firma_sello, m.firma_cert),
    coincideArchivo: m.firma_hash ? (upHex === m.firma_hash) : null,
  });
  if (m.firmada_cliente) signers.push({
    rol: 'Cliente', nombre: m.firma_cliente_nombre, rfc: m.firma_cliente_rfc, serial: m.firma_cliente_serial,
    fecha: m.firma_cliente_fecha, folio: m.firma_cliente_folio, email: m.firma_cliente_email,
    selloValido: verificarSello(m.firma_cliente_hash, m.firma_cliente_sello, m.firma_cliente_cert),
    coincideArchivo: m.firma_cliente_hash ? (upHex === m.firma_cliente_hash) : null,
  });

  return { integrity, uploadedHash: upHex, signers };
}
exports.verificarDocumento = verificarDocumento;

// ── Detectar la posición de los firmantes ("Por ...") en el PDF ───────────────
// Devuelve { admin: {pageIndex,x,y,label}, client: {...} } o null si no se hallan.
async function detectSigners(pdfBytes) {
  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const doc = await pdfjs.getDocument({
      data: Uint8Array.from(pdfBytes), useSystemFonts: true,
      isEvalSupported: false, disableFontFace: true,
    }).promise;

    const items = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const it of content.items) {
        const str = (it.str || '').trim();
        if (!str) continue;
        const tr = it.transform; // [a,b,c,d,e(x),f(y)]
        items.push({ pageIndex: i - 1, x: tr[4], y: tr[5], str });
      }
    }
    await doc.destroy();

    // Localizar cada "Por ..." (etiqueta de firmante)
    const signers = [];
    for (const it of items) {
      if (!/^por[\s.:]/i.test(it.str) && !/^por$/i.test(it.str)) continue;
      const sameLine = items
        .filter((o) => o.pageIndex === it.pageIndex && Math.abs(o.y - it.y) < 3 && o.x >= it.x && o.x < it.x + 200)
        .sort((a, b) => a.x - b.x);
      const label = sameLine.map((o) => o.str).join(' ').replace(/\s+/g, ' ').trim();
      // Evitar duplicados (misma x/página)
      if (signers.some((s) => s.pageIndex === it.pageIndex && Math.abs(s.x - it.x) < 6)) continue;
      signers.push({ pageIndex: it.pageIndex, x: it.x, y: it.y, label });
    }

    if (!signers.length) return null;
    const admin  = signers.find((s) => /business\s*cool/i.test(s.label)) || signers[0];
    const client = signers.find((s) => s !== admin) || null;
    return { admin, client };
  } catch (err) {
    console.error('[firma] detectSigners falló:', err.message);
    return null;
  }
}

// Detecta la FILA de firma (página + altura y) sobre la que van los bloques.
// Se usa para colocar admin (izquierda) y cliente (derecha) a la MISMA altura.
async function detectSignatureRow(pdfBytes) {
  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const doc = await pdfjs.getDocument({
      data: Uint8Array.from(pdfBytes), useSystemFonts: true,
      isEvalSupported: false, disableFontFace: true,
    }).promise;

    const items = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const it of content.items) {
        const s = (it.str || '').trim();
        if (s) items.push({ page: i - 1, x: it.transform[4], y: it.transform[5], str: s });
      }
    }
    await doc.destroy();

    const anchors = [];
    for (const it of items) {
      if (!/^por[\s.:]/i.test(it.str) && !/^por$/i.test(it.str)) continue;
      const sameLine = items
        .filter((o) => o.page === it.page && Math.abs(o.y - it.y) < 3 && o.x >= it.x && o.x < it.x + 220)
        .sort((a, b) => a.x - b.x);
      const label = sameLine.map((o) => o.str).join(' ').replace(/\s+/g, ' ').trim();
      if (/firmado/i.test(label)) continue; // ignora bloques de firma ya dibujados
      anchors.push({ page: it.page, x: it.x, y: it.y, label });
    }
    if (!anchors.length) return null;

    // Preferimos la etiqueta de BusinessCool; el apartado de firmas está al final
    // del documento → mayor página y, dentro de ella, la más abajo (menor y).
    const bc = anchors.filter((a) => /business\s*cool/i.test(a.label));
    const pool = bc.length ? bc : anchors;
    pool.sort((a, b) => (b.page - a.page) || (a.y - b.y));
    const admin = pool[0];
    // Cliente: otro "Por ..." en la misma página y altura, en la columna derecha.
    const client = anchors.find((a) => a.page === admin.page && Math.abs(a.y - admin.y) < 6 && a.x - admin.x > 40);
    return { page: admin.page, y: admin.y, adminX: admin.x, clientX: client ? client.x : null };
  } catch (err) {
    console.error('[firma] detectSignatureRow falló:', err.message);
    return null;
  }
}

// Objetivo de dibujo para una columna (izquierda=admin, derecha=cliente) a la
// altura de la fila de firma. Ambas columnas comparten la misma y → alineadas.
function colTarget(pdfDoc, row, side) {
  const idx = Math.max(0, Math.min(pdfDoc.getPageCount() - 1, parseInt(row.page, 10) || 0));
  const page = pdfDoc.getPages()[idx];
  const { width, height } = page.getSize();
  const colW = Math.min(BLOCK_W, (width - 60 - 16) / 2);
  // El QR se dibuja a (x + 8) dentro del bloque; restamos ese padding para que
  // el borde IZQUIERDO del QR quede alineado con el inicio de la línea del
  // firmante (deja libre el margen izquierdo para perforar/archivar).
  const QR_PAD = 8;
  let x;
  if (side === 'left') {
    const lx = (row.adminX != null) ? Number(row.adminX) : 30;
    x = lx - QR_PAD;
  } else {
    const rx = (row.clientX != null) ? Number(row.clientX) : (width - 30 - colW + QR_PAD);
    x = rx - QR_PAD;
  }
  x = Math.max(6, Math.min(x, width - colW - 6));
  let bottomY = Number(row.y) + 16; // justo arriba de la línea del firmante
  if (bottomY + BLOCK_H > height - 18) bottomY = height - 18 - BLOCK_H;
  if (bottomY < 12) bottomY = 12;
  return { pageIndex: idx, x, bottomY, w: colW };
}

// ── Dibujar bloque de firma compacto (QR + datos) ────────────────────────────
function drawCompactBlock(page, font, fontB, rgb, { x, bottomY, w, data, qrImg }) {
  const H = BLOCK_H;
  // Sin recuadro: solo QR + datos para que no sobresalga de la línea del firmante.

  const qr = 84;
  if (qrImg) page.drawImage(qrImg, { x: x + 8, y: bottomY + (H - qr) / 2, width: qr, height: qr });

  const tx = x + qr + 16;
  const tw = w - qr - 24;

  // Dibuja una línea ajustando el tamaño de fuente para que nunca se desborde
  const drawFit = (text, y, size, fnt, color, min) => {
    let s = size;
    while (s > (min || 5) && fnt.widthOfTextAtSize(text, s) > tw) s -= 0.25;
    page.drawText(text, { x: tx, y, size: s, font: fnt, color });
  };

  let ty = bottomY + H - 15;
  page.drawText('Firmado electronicamente por:', { x: tx, y: ty, size: 7, font: fontB, color: rgb(0.30, 0.30, 0.42) });
  ty -= 13;
  drawFit(String(data.nombre || '—'), ty, 9.5, fontB, rgb(0.12, 0.34, 0.72), 7);
  ty -= 14;
  const rows = [
    ['No. Cert:', data.serial],
    ['RFC:', data.rfc],
    ['Correo:', data.email],
    ['Fecha:', data.fecha],
    ['Folio:', data.folio],
  ];
  for (const [lbl, val] of rows) {
    drawFit(`${lbl} ${val == null || val === '' ? '—' : val}`, ty, 7, font, rgb(0.20, 0.20, 0.30), 5.5);
    ty -= 10.5;
  }
  return H;
}

// Convierte coordenadas del colocador (página 1-based, x/y como fracción 0..1
// de la esquina superior-izquierda, Y medida desde ARRIBA) a un objetivo de dibujo.
function placementToTarget(pdfDoc, placement) {
  if (!placement || placement.x == null || placement.y == null) return null;
  const idx = Math.max(0, Math.min(pdfDoc.getPageCount() - 1, (parseInt(placement.page, 10) || 1) - 1));
  const page = pdfDoc.getPages()[idx];
  const { width, height } = page.getSize();
  const w = Math.min(BLOCK_W, width - 12);
  const x = Math.max(6, Math.min(Number(placement.x) * width, width - w - 6));
  const topY = height * (1 - Number(placement.y));      // borde superior del recuadro
  const bottomY = Math.max(6, topY - BLOCK_H);
  return { pageIndex: idx, x, bottomY, w };
}

// Coloca el bloque: 1) en coordenadas manuales, 2) sobre la línea detectada,
// o 3) al pie de la última página (fallback).
function placeBlock(pdfDoc, font, fontB, rgb, target, anchor, fallbackSide, data, qrImg) {
  let page, x, bottomY, w;
  if (target) {
    page = pdfDoc.getPages()[target.pageIndex];
    ({ x, bottomY, w } = target);
  } else if (anchor) {
    page = pdfDoc.getPages()[anchor.pageIndex];
    const { width, height } = page.getSize();
    x = Math.max(24, anchor.x - 2);
    w = Math.min(BLOCK_W, width - x - 24);
    bottomY = anchor.y + 16; // justo arriba de la línea (que está sobre el texto "Por …")
    if (bottomY + BLOCK_H > height - 24) bottomY = height - 24 - BLOCK_H;
  } else {
    // Fallback: parte inferior de la última página
    page = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const { width } = page.getSize();
    w = Math.min(BLOCK_W, width / 2 - 36);
    x = fallbackSide === 'right' ? width - w - 30 : 30;
    bottomY = 48;
  }
  drawCompactBlock(page, font, fontB, rgb, { x, bottomY, w, data, qrImg });
}

function drawFooters(pdfDoc, font, rgb, footerTxt) {
  for (const page of pdfDoc.getPages()) {
    page.drawText(footerTxt, { x: 28, y: 13, size: 6, font, color: rgb(0.44, 0.44, 0.44) });
  }
}

// ── Firma ADMIN: dibuja el bloque sobre la línea de BusinessCool ──────────────
async function firmarPDF(minutaId, m, keyBuf, cerBuf, passphrase, actorUserId, ip, placement) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  const certData = parseCert(cerBuf);
  const privKey  = decryptKey(keyBuf, passphrase);

  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  const pdfBytes = fs.readFileSync(filePath);

  // Sello de integridad
  const md = forge.md.sha256.create();
  md.update(pdfBytes.toString('binary'));
  privKey.sign(md);

  const folio      = crypto.randomUUID();
  const clave      = String(minutaId).padStart(5, '0');
  const fechaFirma = fechaMX();

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Detecta la fila de firmantes (apartados "Por ...") en el documento limpio.
  // Admin va en la columna izquierda; el cliente, luego, en la derecha — misma altura.
  const row = (await detectSignatureRow(pdfBytes)) || { page: pdfDoc.getPageCount() - 1, y: 150 };

  drawFooters(pdfDoc, font, rgb, `Clave: ${clave}  Folio BC: ${folio}`);

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${folio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const adminData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio, fecha: fechaFirma,
  };
  placeBlock(pdfDoc, font, fontB, rgb, colTarget(pdfDoc, row, 'left'), null, 'left', adminData, qrImg);

  const signedBytes = await pdfDoc.save();
  const ext         = path.extname(m.archivo_path);
  const signedFile  = path.basename(m.archivo_path, ext) + '_firmado' + ext;
  fs.writeFileSync(path.join(MINUTAS_DIR, signedFile), signedBytes);

  // Sello criptográfico sobre los bytes finales del PDF
  const { hashHex, sello } = sellarBytes(privKey, signedBytes);
  const certPem = cerToPem(cerBuf);

  const extO       = path.extname(m.archivo_nombre || 'minuta.pdf');
  const signedName = path.basename(m.archivo_nombre || 'minuta.pdf', extO) + '_firmado' + extO;

  db.prepare(`UPDATE minutas SET firmada=1, firma_serial=?, firma_nombre=?, firma_fecha=?,
              firma_folio=?, firma_email=?, firma_rfc=?, firma_hash=?, firma_sello=?, firma_cert=?,
              firma_slots=?, archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, fechaFirma, folio, certData.email, certData.rfc,
         hashHex, sello, certPem, JSON.stringify(row), signedFile, signedName, minutaId);

  if (actorUserId) logAction(actorUserId, 'minuta_pdf_signed', `${m.titulo} · ${certData.serial}`, ip);
  return { folio, clave, ...certData, fechaFirma };
}

exports.firmarPDF = firmarPDF;

// ── Firma CLIENTE: dibuja el bloque sobre la línea del cliente ────────────────
async function firmarPDFCliente(minutaId, m, keyBuf, cerBuf, passphrase, actorUserId, ip, placement) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  const certData = parseCert(cerBuf);
  const privKey  = decryptKey(keyBuf, passphrase);

  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  const pdfBytes = fs.readFileSync(filePath);
  const md = forge.md.sha256.create();
  md.update(pdfBytes.toString('binary'));
  privKey.sign(md);

  const clientFolio = crypto.randomUUID();
  const fechaFirma  = fechaMX();

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Reusa la MISMA fila que detectó el admin (guardada en firma_slots) para que
  // ambas firmas queden a la misma altura. Si no hay, detecta como respaldo.
  let row = null;
  try { row = m.firma_slots ? JSON.parse(m.firma_slots) : null; } catch (_) { row = null; }
  if (!row) row = (await detectSignatureRow(pdfBytes)) || { page: pdfDoc.getPageCount() - 1, y: 150 };

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${clientFolio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const clientData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio: clientFolio, fecha: fechaFirma,
  };
  placeBlock(pdfDoc, font, fontB, rgb, colTarget(pdfDoc, row, 'right'), null, 'right', clientData, qrImg);

  // Folio del cliente en el pie de todas las hojas (alineado a la derecha,
  // junto al "Folio BC" del admin que ya quedó horneado en el documento).
  const cfTxt = `Folio cliente: ${clientFolio}`;
  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    const tw = font.widthOfTextAtSize(cfTxt, 6);
    page.drawText(cfTxt, { x: width - 28 - tw, y: 13, size: 6, font, color: rgb(0.44, 0.44, 0.44) });
  }

  const signedBytes = await pdfDoc.save();
  const ext         = path.extname(m.archivo_path);
  const base        = path.basename(m.archivo_path, ext).replace(/_cliente$/, '');
  const newFile     = base + '_cliente' + ext;
  fs.writeFileSync(path.join(MINUTAS_DIR, newFile), signedBytes);

  // Sello criptográfico del cliente sobre los bytes finales (documento completo)
  const { hashHex, sello } = sellarBytes(privKey, signedBytes);
  const certPem = cerToPem(cerBuf);

  const extO    = path.extname(m.archivo_nombre || 'minuta.pdf');
  const newName = path.basename(m.archivo_nombre || 'minuta.pdf', extO).replace(/_cliente$/, '') + '_cliente' + extO;

  db.prepare(`UPDATE minutas SET firmada_cliente=1, firma_cliente_serial=?, firma_cliente_nombre=?,
              firma_cliente_fecha=?, firma_cliente_folio=?, firma_cliente_email=?, firma_cliente_rfc=?,
              firma_cliente_hash=?, firma_cliente_sello=?, firma_cliente_cert=?,
              archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, fechaFirma, clientFolio, certData.email, certData.rfc,
         hashHex, sello, certPem, newFile, newName, minutaId);

  if (actorUserId) logAction(actorUserId, 'minuta_cliente_firmada', `${m.titulo} · ${certData.serial}`, ip);
  return { folio: clientFolio, ...certData, fechaFirma };
}

exports.firmarPDFCliente = firmarPDFCliente;

// ════════ CONTRATO DE PROYECTO ════════════════════════════════════════════
// Mismo mecanismo de e.firma que las minutas, pero sobre el contrato (PDF) de
// un proyecto y escribiendo en la tabla projects (columnas cont_*).

// ── Firma ADMIN del contrato (columna izquierda, BusinessCool) ───────────────
async function firmarContrato(projectId, p, keyBuf, cerBuf, passphrase, actorUserId, ip) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  const certData = parseCert(cerBuf);
  const privKey  = decryptKey(keyBuf, passphrase);

  const filePath = path.join(CONTRATOS_DIR, p.contrato_path);
  const pdfBytes = fs.readFileSync(filePath);

  const folio      = crypto.randomUUID();
  const fechaFirma = fechaMX();

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const row = (await detectSignatureRow(pdfBytes)) || { page: pdfDoc.getPageCount() - 1, y: 120 };
  drawFooters(pdfDoc, font, rgb, `Contrato · Folio BC: ${folio}`);

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${folio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const adminData = { nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial, email: certData.email, folio, fecha: fechaFirma };
  placeBlock(pdfDoc, font, fontB, rgb, colTarget(pdfDoc, row, 'left'), null, 'left', adminData, qrImg);

  const signedBytes = await pdfDoc.save();
  const ext        = path.extname(p.contrato_path);
  const signedFile = path.basename(p.contrato_path, ext) + '_firmado' + ext;
  fs.writeFileSync(path.join(CONTRATOS_DIR, signedFile), signedBytes);

  const { hashHex, sello } = sellarBytes(privKey, signedBytes);
  const certPem = cerToPem(cerBuf);
  const extO       = path.extname(p.contrato_nombre || 'contrato.pdf');
  const signedName = path.basename(p.contrato_nombre || 'contrato.pdf', extO) + '_firmado' + extO;

  db.prepare(`UPDATE projects SET cont_firmada=1, cont_firma_serial=?, cont_firma_nombre=?, cont_firma_fecha=?,
              cont_firma_folio=?, cont_firma_email=?, cont_firma_rfc=?, cont_firma_hash=?, cont_firma_sello=?, cont_firma_cert=?,
              cont_firma_slots=?, contrato_path=?, contrato_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, fechaFirma, folio, certData.email, certData.rfc,
         hashHex, sello, certPem, JSON.stringify(row), signedFile, signedName, projectId);

  if (actorUserId) logAction(actorUserId, 'contrato_firmado', `${p.name} · ${certData.serial}`, ip);
  return { folio, ...certData, fechaFirma };
}
exports.firmarContrato = firmarContrato;

// ── Firma CLIENTE del contrato (columna derecha) ─────────────────────────────
async function firmarContratoCliente(projectId, p, keyBuf, cerBuf, passphrase, actorUserId, ip) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  const certData = parseCert(cerBuf);
  const privKey  = decryptKey(keyBuf, passphrase);

  const filePath = path.join(CONTRATOS_DIR, p.contrato_path);
  const pdfBytes = fs.readFileSync(filePath);

  const clientFolio = crypto.randomUUID();
  const fechaFirma  = fechaMX();

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let row = null;
  try { row = p.cont_firma_slots ? JSON.parse(p.cont_firma_slots) : null; } catch (_) { row = null; }
  if (!row) row = (await detectSignatureRow(pdfBytes)) || { page: pdfDoc.getPageCount() - 1, y: 120 };

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${clientFolio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const clientData = { nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial, email: certData.email, folio: clientFolio, fecha: fechaFirma };
  placeBlock(pdfDoc, font, fontB, rgb, colTarget(pdfDoc, row, 'right'), null, 'right', clientData, qrImg);

  const cfTxt = `Folio cliente: ${clientFolio}`;
  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    const tw = font.widthOfTextAtSize(cfTxt, 6);
    page.drawText(cfTxt, { x: width - 28 - tw, y: 13, size: 6, font, color: rgb(0.44, 0.44, 0.44) });
  }

  const signedBytes = await pdfDoc.save();
  const ext     = path.extname(p.contrato_path);
  const base    = path.basename(p.contrato_path, ext).replace(/_cliente$/, '');
  const newFile = base + '_cliente' + ext;
  fs.writeFileSync(path.join(CONTRATOS_DIR, newFile), signedBytes);

  const { hashHex, sello } = sellarBytes(privKey, signedBytes);
  const certPem = cerToPem(cerBuf);
  const extO    = path.extname(p.contrato_nombre || 'contrato.pdf');
  const newName = path.basename(p.contrato_nombre || 'contrato.pdf', extO).replace(/_cliente$/, '') + '_cliente' + extO;

  db.prepare(`UPDATE projects SET cont_firmada_cliente=1, cont_fc_serial=?, cont_fc_nombre=?,
              cont_fc_fecha=?, cont_fc_folio=?, cont_fc_email=?, cont_fc_rfc=?,
              cont_fc_hash=?, cont_fc_sello=?, cont_fc_cert=?, contrato_path=?, contrato_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, fechaFirma, clientFolio, certData.email, certData.rfc,
         hashHex, sello, certPem, newFile, newName, projectId);

  if (actorUserId) logAction(actorUserId, 'contrato_firmado_cliente', `${p.name} · ${certData.serial}`, ip);
  return { folio: clientFolio, ...certData, fechaFirma };
}
exports.firmarContratoCliente = firmarContratoCliente;
