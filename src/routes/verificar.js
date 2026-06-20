'use strict';

const express = require('express');
const multer  = require('multer');
const { db } = require('../db');
const config = require('../config');
const { verificarDocumento } = require('../lib/minuta-firma');

const router = express.Router();

// Carga en memoria (no se guarda); solo para recalcular el hash.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function buscarMinuta(folio) {
  return db.prepare('SELECT * FROM minutas WHERE firma_folio = ? OR firma_cliente_folio = ?').get(folio, folio);
}

function firmasDe(m, folio) {
  const firmas = [];
  if (m) {
    if (m.firmada && m.firma_folio) {
      firmas.push({
        rol: 'BusinessCool AI', nombre: m.firma_nombre, rfc: m.firma_rfc,
        fecha: m.firma_fecha, serial: m.firma_serial, folio: m.firma_folio,
        email: m.firma_email, match: m.firma_folio === folio,
      });
    }
    if (m.firmada_cliente && m.firma_cliente_folio) {
      firmas.push({
        rol: 'Cliente', nombre: m.firma_cliente_nombre, rfc: m.firma_cliente_rfc,
        fecha: m.firma_cliente_fecha, serial: m.firma_cliente_serial, folio: m.firma_cliente_folio,
        email: m.firma_cliente_email, match: m.firma_cliente_folio === folio,
      });
    }
  }
  return firmas;
}

function render(res, m, folio, verify) {
  const firmas = firmasDe(m, folio);
  res.render('verificar', {
    title: 'Verificación de firma',
    brand: config.brand,
    found: !!(m && firmas.length),
    folio,
    documento: m ? { titulo: m.titulo, fecha: m.fecha, empresa: m.company_name } : null,
    firmas,
    verify: verify || null,
  });
}

// Página pública de verificación (la abre el QR del PDF).
router.get('/:folio', (req, res) => {
  const folio = String(req.params.folio || '').trim();
  render(res, buscarMinuta(folio), folio, null);
});

// Verificación por carga de archivo: recalcula el hash y valida los sellos.
router.post('/:folio', upload.single('pdf'), (req, res) => {
  const folio = String(req.params.folio || '').trim();
  const m = buscarMinuta(folio);
  let verify = null;
  if (m && req.file && req.file.buffer) {
    try {
      verify = verificarDocumento(m, req.file.buffer);
    } catch (err) {
      verify = { error: 'No se pudo procesar el archivo: ' + err.message };
    }
  } else if (!req.file) {
    verify = { error: 'Sube el archivo PDF para verificarlo.' };
  }
  render(res, m, folio, verify);
});

module.exports = router;
