'use strict';

const forge  = require('node-forge');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const config = require('../config');
const { db, logAction } = require('../db');

const MINUTAS_DIR = path.join(config.uploadsDir, 'minutas');
if (!fs.existsSync(MINUTAS_DIR)) fs.mkdirSync(MINUTAS_DIR, { recursive: true });

exports.MINUTAS_DIR = MINUTAS_DIR;

// ── Parsear certificado SAT (.cer DER → datos del firmante) ──────────────────
function parseCert(cerBuf) {
  const b64 = cerBuf.toString('base64');
  const pem = '-----BEGIN CERTIFICATE-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
  const cert = forge.pki.certificateFromPem(pem);

  const serial = cert.serialNumber.replace(/^0+/, '');
  const cn     = (cert.subject.getField('CN') || {}).value || '';
  const ou     = (cert.subject.getField('OU') || {}).value || 'AC DEL SERVICIO DE ADMINISTRACION TRIBUTARIA';
  const emailF = cert.subject.getField('E') || cert.subject.getField('1.2.840.113549.1.9.1');
  const email  = emailF ? emailF.value : '';
  const rfcM   = cn.match(/([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
  const rfc    = rfcM ? rfcM[1].toUpperCase() : '';
  const nomM   = cn.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\s*\/?\s*(.+)/i);
  const nombre = nomM ? nomM[1].trim() : cn;

  return { serial, cn, cnAC: ou, email, rfc, nombre };
}

// ── Descifrar llave privada SAT (.key DER → clave privada) ───────────────────
function decryptKey(keyBuf, passphrase) {
  const b64 = keyBuf.toString('base64');
  const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END ENCRYPTED PRIVATE KEY-----';
  const key = forge.pki.decryptRsaPrivateKey(pem, passphrase);
  if (!key) throw new Error('Contraseña incorrecta o archivo .key inválido.');
  return key;
}

// ── Dibujar bloque de firma estilo SAT ───────────────────────────────────────
function drawSignatureBlock(page, font, fontB, rgb, { x, y, w, label, data, qrImg }) {
  const BOX_H = 148;

  // Etiqueta de sección
  page.drawText(label, { x: x + 4, y: y + 5, size: 7.5, font: fontB, color: rgb(0.22, 0.22, 0.38) });
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.5, color: rgb(0.74, 0.74, 0.84) });

  // Caja de fondo
  page.drawRectangle({
    x, y: y - BOX_H, width: w, height: BOX_H,
    color: rgb(0.976, 0.976, 0.990), borderColor: rgb(0.75, 0.75, 0.84), borderWidth: 0.6,
  });

  if (!data) {
    page.drawText('Pendiente de firma', { x: x + 20, y: y - BOX_H / 2 - 2, size: 9, font: fontB, color: rgb(0.68, 0.68, 0.74) });
    page.drawText('El firmante puede validar este documento con su e.firma (FIEL).',
      { x: x + 20, y: y - BOX_H / 2 - 14, size: 7, font, color: rgb(0.62, 0.62, 0.68) });
    return BOX_H;
  }

  // Código QR
  const qrS = 92;
  if (qrImg) {
    page.drawImage(qrImg, { x: x + 8, y: y - qrS - 8, width: qrS, height: qrS });
    page.drawLine({
      start: { x: x + qrS + 16, y: y - 6 }, end: { x: x + qrS + 16, y: y - BOX_H + 6 },
      thickness: 0.4, color: rgb(0.80, 0.80, 0.88),
    });
  }

  // Campos de datos (derecha del QR)
  const qrW = qrImg ? 112 : 8;
  const dx  = x + qrW + 12;
  const maxChar = Math.floor((w - qrW - 20) / 3.5);
  let dy = y - 12;

  const rows = [
    { lbl: 'Firmado electronicamente por:', val: data.nombre, blue: true },
    { lbl: 'No. Certificado:', val: data.serial },
    { lbl: 'No. RFC:', val: data.rfc },
    { lbl: 'Fecha:', val: data.fecha },
    { lbl: 'Folio:', val: data.folio },
    { lbl: 'Correo electronico:', val: data.email },
  ];

  for (const { lbl, val, blue } of rows) {
    page.drawText(lbl, { x: dx, y: dy, size: 7, font: fontB, color: rgb(0.26, 0.26, 0.38) });
    dy -= 10;
    const v = (val || '—').length > maxChar ? (val || '').slice(0, maxChar) + '...' : (val || '—');
    page.drawText(v, { x: dx, y: dy, size: 7.5, font: fontB,
      color: blue ? rgb(0.12, 0.34, 0.72) : rgb(0.07, 0.07, 0.20) });
    dy -= 16;
  }

  return BOX_H;
}

// ── Añadir página de firma al PDFDocument ────────────────────────────────────
function addSignaturePage(pdfDoc, font, fontB, rgb, { footerTxt, fechaStr, adminData, adminQrImg, clientData, clientQrImg }) {
  const W = 595.28, H = 841.89, MX = 36;
  const sp = pdfDoc.addPage([W, H]);
  let y = H - MX;

  // Barra de título
  sp.drawRectangle({ x: MX - 6, y: y - 30, width: W - 2 * (MX - 6), height: 30, color: rgb(0.10, 0.13, 0.21) });
  sp.drawText('FIRMA ELECTRONICA DE DOCUMENTOS', { x: MX + 2, y: y - 21, size: 10, font: fontB, color: rgb(0.99, 0.99, 0.99) });
  sp.drawText('BusinessCool AI', { x: W - MX - 95, y: y - 21, size: 9, font: fontB, color: rgb(0.98, 0.75, 0.14) });
  y -= 38;

  // Bloque admin
  const adminH = drawSignatureBlock(sp, font, fontB, rgb, {
    x: MX - 4, y, w: W - 2 * MX + 8, label: 'Firma BusinessCool AI',
    data: adminData, qrImg: adminQrImg,
  });
  y -= adminH + 16;

  // Bloque cliente
  drawSignatureBlock(sp, font, fontB, rgb, {
    x: MX - 4, y, w: W - 2 * MX + 8, label: 'Firma del cliente',
    data: clientData, qrImg: clientQrImg,
  });

  // Footer
  sp.drawLine({ start: { x: MX - 6, y: MX + 18 }, end: { x: W - MX + 6, y: MX + 18 }, thickness: 0.4, color: rgb(0.65, 0.65, 0.65) });
  sp.drawText(footerTxt, { x: MX, y: MX + 7, size: 7, font, color: rgb(0.42, 0.42, 0.42) });
  sp.drawText(fechaStr, { x: W - MX - 125, y: MX + 7, size: 7, font, color: rgb(0.42, 0.42, 0.42) });
}

// ── Firma ADMIN: añade página de firma al PDF ─────────────────────────────────
async function firmarPDF(minutaId, m, keyBuf, cerBuf, passphrase, actorUserId, ip) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  const certData = parseCert(cerBuf);
  const privKey  = decryptKey(keyBuf, passphrase);

  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  const pdfBytes = fs.readFileSync(filePath);

  // Firmar el contenido del PDF
  const md = forge.md.sha256.create();
  md.update(pdfBytes.toString('binary'));
  forge.util.encode64(privKey.sign(md)); // firma guardada en metadata (integridad)

  const folio     = crypto.randomUUID();
  const clave     = String(minutaId).padStart(5, '0');
  const fechaFirma = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Footer en páginas existentes
  const footerTxt = `Clave: ${clave}  Folio: ${folio}`;
  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    page.drawLine({ start: { x: 28, y: 26 }, end: { x: width - 28, y: 26 }, thickness: 0.4, color: rgb(0.65, 0.65, 0.65) });
    page.drawText(footerTxt, { x: 28, y: 14, size: 6.5, font, color: rgb(0.42, 0.42, 0.42) });
  }

  // QR del admin
  const qrBuf = await QRCode.toBuffer(`https://proyectos.businesscool.ai/verificar/${folio}`,
    { width: 130, margin: 1, type: 'png', errorCorrectionLevel: 'M' });
  const qrImg = await pdfDoc.embedPng(qrBuf);

  const adminData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio, fecha: fechaFirma,
  };

  addSignaturePage(pdfDoc, font, fontB, rgb, {
    footerTxt, fechaStr: fechaFirma,
    adminData, adminQrImg: qrImg,
    clientData: null, clientQrImg: null,
  });

  const signedBytes   = await pdfDoc.save();
  const ext           = path.extname(m.archivo_path);
  const signedFile    = path.basename(m.archivo_path, ext) + '_firmado' + ext;
  fs.writeFileSync(path.join(MINUTAS_DIR, signedFile), signedBytes);

  const extO        = path.extname(m.archivo_nombre || 'minuta.pdf');
  const signedName  = path.basename(m.archivo_nombre || 'minuta.pdf', extO) + '_firmado' + extO;
  const nowISO      = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`UPDATE minutas SET firmada=1, firma_serial=?, firma_nombre=?, firma_fecha=?,
              firma_folio=?, firma_email=?, firma_rfc=?, archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, nowISO, folio, certData.email, certData.rfc, signedFile, signedName, minutaId);

  if (actorUserId) logAction(actorUserId, 'minuta_pdf_signed', `${m.titulo} · ${certData.serial}`, ip);
  return { folio, clave, ...certData, fechaFirma };
}

exports.firmarPDF = firmarPDF;

// ── Firma CLIENTE: añade/actualiza bloque de firma del cliente en el PDF ──────
async function firmarPDFCliente(minutaId, m, keyBuf, cerBuf, passphrase, actorUserId, ip) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const QRCode = require('qrcode');

  const certData = parseCert(cerBuf);
  const privKey  = decryptKey(keyBuf, passphrase);

  // Firmar el PDF actual
  const filePath = path.join(MINUTAS_DIR, m.archivo_path);
  const pdfBytes = fs.readFileSync(filePath);
  const md = forge.md.sha256.create();
  md.update(pdfBytes.toString('binary'));
  forge.util.encode64(privKey.sign(md));

  const clientFolio = crypto.randomUUID();
  const clave       = String(minutaId).padStart(5, '0');
  const fechaFirma  = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // Cargar PDF firmado por admin, quitar la última página (página de firma)
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  pdfDoc.removePage(pdfDoc.getPageCount() - 1);

  // Regenerar QR del admin y generar QR del cliente
  const adminFolio = m.firma_folio || '';
  const adminQrBuf = await QRCode.toBuffer(`https://proyectos.businesscool.ai/verificar/${adminFolio}`,
    { width: 130, margin: 1, type: 'png' });
  const adminQrImg = await pdfDoc.embedPng(adminQrBuf);

  const clientQrBuf = await QRCode.toBuffer(`https://proyectos.businesscool.ai/verificar/${clientFolio}`,
    { width: 130, margin: 1, type: 'png' });
  const clientQrImg = await pdfDoc.embedPng(clientQrBuf);

  const adminData = {
    nombre: m.firma_nombre || '', rfc: m.firma_rfc || '',
    serial: m.firma_serial || '', email: m.firma_email || '',
    folio: adminFolio, fecha: m.firma_fecha || '',
  };
  const clientData = {
    nombre: certData.nombre, rfc: certData.rfc, serial: certData.serial,
    email: certData.email, folio: clientFolio, fecha: fechaFirma,
  };

  const footerTxt = `Clave: ${clave}  Folio: ${adminFolio || clientFolio}`;
  addSignaturePage(pdfDoc, font, fontB, rgb, {
    footerTxt, fechaStr: m.firma_fecha || fechaFirma,
    adminData, adminQrImg, clientData, clientQrImg,
  });

  const signedBytes = await pdfDoc.save();
  const ext         = path.extname(m.archivo_path);
  const base        = path.basename(m.archivo_path, ext).replace(/_cliente$/, '');
  const newFile     = base + '_cliente' + ext;
  fs.writeFileSync(path.join(MINUTAS_DIR, newFile), signedBytes);

  const extO    = path.extname(m.archivo_nombre || 'minuta.pdf');
  const newName = path.basename(m.archivo_nombre || 'minuta.pdf', extO).replace(/_cliente$/, '') + '_cliente' + extO;
  const nowISO  = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`UPDATE minutas SET firmada_cliente=1, firma_cliente_serial=?, firma_cliente_nombre=?,
              firma_cliente_fecha=?, firma_cliente_folio=?, firma_cliente_email=?, firma_cliente_rfc=?,
              archivo_path=?, archivo_nombre=? WHERE id=?`)
    .run(certData.serial, certData.nombre, nowISO, clientFolio, certData.email, certData.rfc,
         newFile, newName, minutaId);

  if (actorUserId) logAction(actorUserId, 'minuta_cliente_firmada', `${m.titulo} · ${certData.serial}`, ip);
  return { folio: clientFolio, ...certData, fechaFirma };
}

exports.firmarPDFCliente = firmarPDFCliente;
