'use strict';

const forge  = require('node-forge');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const config = require('../config');
const { db, logAction } = require('../db');

const MINUTAS_DIR = path.join(config.uploadsDir, 'minutas');
if (!fs.existsSync(MINUTAS_DIR)) fs.mkdirSync(MINUTAS_DIR, { recursive: true });

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

  // 1) coordenadas manuales del colocador; si no hay, 2) detección automática
  const target  = placementToTarget(pdfDoc, placement);
  const signers = target ? null : await detectSigners(pdfBytes);

  drawFooters(pdfDoc, font, rgb, `Clave: ${clave}  Folio BC: ${folio}`);

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${folio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const adminData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio, fecha: fechaFirma,
  };
  placeBlock(pdfDoc, font, fontB, rgb, target, signers && signers.admin, 'left', adminData, qrImg);

  const signedBytes = await pdfDoc.save();
  const ext         = path.extname(m.archivo_path);
  const signedFile  = path.basename(m.archivo_path, ext) + '_firmado' + ext;
  fs.writeFileSync(path.join(MINUTAS_DIR, signedFile), signedBytes);

  const extO       = path.extname(m.archivo_nombre || 'minuta.pdf');
  const signedName = path.basename(m.archivo_nombre || 'minuta.pdf', extO) + '_firmado' + extO;
  const nowISO     = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`UPDATE minutas SET firmada=1, firma_serial=?, firma_nombre=?, firma_fecha=?,
              firma_folio=?, firma_email=?, firma_rfc=?, archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, fechaFirma, folio, certData.email, certData.rfc, signedFile, signedName, minutaId);

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

  // 1) coordenadas manuales del colocador; si no hay, 2) detección automática
  const target  = placementToTarget(pdfDoc, placement);
  const signers = target ? null : await detectSigners(pdfBytes);

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${clientFolio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const clientData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio: clientFolio, fecha: fechaFirma,
  };
  const anchor = signers && signers.client;
  placeBlock(pdfDoc, font, fontB, rgb, target, anchor, 'right', clientData, qrImg);

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

  const extO    = path.extname(m.archivo_nombre || 'minuta.pdf');
  const newName = path.basename(m.archivo_nombre || 'minuta.pdf', extO).replace(/_cliente$/, '') + '_cliente' + extO;

  db.prepare(`UPDATE minutas SET firmada_cliente=1, firma_cliente_serial=?, firma_cliente_nombre=?,
              firma_cliente_fecha=?, firma_cliente_folio=?, firma_cliente_email=?, firma_cliente_rfc=?,
              archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, fechaFirma, clientFolio, certData.email, certData.rfc,
         newFile, newName, minutaId);

  if (actorUserId) logAction(actorUserId, 'minuta_cliente_firmada', `${m.titulo} · ${certData.serial}`, ip);
  return { folio: clientFolio, ...certData, fechaFirma };
}

exports.firmarPDFCliente = firmarPDFCliente;
