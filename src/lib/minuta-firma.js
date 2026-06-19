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

exports.MINUTAS_DIR = MINUTAS_DIR;

// ── Parsear certificado SAT (.cer DER → datos del firmante) ──────────────────
function parseCert(cerBuf) {
  const b64 = cerBuf.toString('base64');
  const pem = '-----BEGIN CERTIFICATE-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
  const cert = forge.pki.certificateFromPem(pem);

  const serial = cert.serialNumber.replace(/^0+/, '');
  const cn     = (cert.subject.getField('CN') || {}).value || '';
  const emailF = cert.subject.getField('E') || cert.subject.getField('1.2.840.113549.1.9.1');
  const email  = emailF ? emailF.value : '';
  const rfcM   = cn.match(/([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
  const rfc    = rfcM ? rfcM[1].toUpperCase() : '';
  const nomM   = cn.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\s*\/?\s*(.+)/i);
  const nombre = nomM ? nomM[1].trim() : cn;

  return { serial, cn, email, rfc, nombre };
}

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
  const H = 60;
  page.drawRectangle({
    x, y: bottomY, width: w, height: H,
    color: rgb(0.980, 0.980, 0.995), borderColor: rgb(0.74, 0.74, 0.84), borderWidth: 0.5,
  });

  const qr = 46;
  if (qrImg) page.drawImage(qrImg, { x: x + 5, y: bottomY + (H - qr) / 2, width: qr, height: qr });

  const tx = x + qr + 12;
  const tw = w - qr - 18;
  const maxChar = Math.max(12, Math.floor(tw / 3.0));
  const trunc = (v, n) => { v = String(v == null || v === '' ? '—' : v); return v.length > n ? v.slice(0, n) + '…' : v; };

  let ty = bottomY + H - 9;
  page.drawText('Firmado electronicamente por:', { x: tx, y: ty, size: 5.2, font: fontB, color: rgb(0.30, 0.30, 0.42) });
  ty -= 8.5;
  page.drawText(trunc(data.nombre, maxChar), { x: tx, y: ty, size: 6.6, font: fontB, color: rgb(0.12, 0.34, 0.72) });
  ty -= 9;
  const rows = [['No. Cert:', data.serial], ['RFC:', data.rfc], ['Fecha:', data.fecha], ['Folio:', data.folio]];
  for (const [lbl, val] of rows) {
    page.drawText(`${lbl} ${trunc(val, maxChar - lbl.length)}`, { x: tx, y: ty, size: 5.3, font, color: rgb(0.20, 0.20, 0.30) });
    ty -= 7.6;
  }
  return H;
}

// Coloca un bloque encima de la línea del firmante (o, si no se detectó, abajo).
function placeBlock(pdfDoc, font, fontB, rgb, anchor, fallbackSide, data, qrImg) {
  const H = 60;
  let page, x, bottomY, w;
  if (anchor) {
    page = pdfDoc.getPages()[anchor.pageIndex];
    const { width, height } = page.getSize();
    x = Math.max(24, anchor.x - 2);
    w = Math.min(255, width - x - 24);
    bottomY = anchor.y + 16; // justo arriba de la línea (que está sobre el texto "Por …")
    if (bottomY + H > height - 24) bottomY = height - 24 - H;
  } else {
    // Fallback: parte inferior de la última página
    page = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const { width } = page.getSize();
    w = Math.min(255, width / 2 - 36);
    x = fallbackSide === 'right' ? width - w - 30 : 30;
    bottomY = 48;
  }
  drawCompactBlock(page, font, fontB, rgb, { x, bottomY, w, data, qrImg });
}

function drawFooters(pdfDoc, font, rgb, footerTxt) {
  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    page.drawLine({ start: { x: 28, y: 24 }, end: { x: width - 28, y: 24 }, thickness: 0.4, color: rgb(0.66, 0.66, 0.66) });
    page.drawText(footerTxt, { x: 28, y: 13, size: 6, font, color: rgb(0.44, 0.44, 0.44) });
  }
}

// ── Firma ADMIN: dibuja el bloque sobre la línea de BusinessCool ──────────────
async function firmarPDF(minutaId, m, keyBuf, cerBuf, passphrase, actorUserId, ip) {
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

  const signers = await detectSigners(pdfBytes);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  drawFooters(pdfDoc, font, rgb, `Clave: ${clave}  Folio: ${folio}`);

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${folio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const adminData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio, fecha: fechaFirma,
  };
  placeBlock(pdfDoc, font, fontB, rgb, signers && signers.admin, 'left', adminData, qrImg);

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
async function firmarPDFCliente(minutaId, m, keyBuf, cerBuf, passphrase, actorUserId, ip) {
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

  const signers = await detectSigners(pdfBytes);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const qrBuf = await QRCode.toBuffer(`${VERIFY_BASE}/${clientFolio}`, { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const clientData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio: clientFolio, fecha: fechaFirma,
  };
  // Usa la línea del cliente; si solo se detectó una, cae a la derecha abajo
  const anchor = signers && (signers.client || (signers.admin ? null : null));
  placeBlock(pdfDoc, font, fontB, rgb, anchor, 'right', clientData, qrImg);

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
