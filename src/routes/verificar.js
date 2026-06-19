'use strict';

const express = require('express');
const { db } = require('../db');
const config = require('../config');

const router = express.Router();

// Página pública de verificación de firma electrónica (la abre el QR del PDF).
router.get('/:folio', (req, res) => {
  const folio = String(req.params.folio || '').trim();
  const m = db.prepare(
    'SELECT * FROM minutas WHERE firma_folio = ? OR firma_cliente_folio = ?'
  ).get(folio, folio);

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

  res.render('verificar', {
    title: 'Verificación de firma',
    brand: config.brand,
    found: !!(m && firmas.length),
    folio,
    documento: m ? { titulo: m.titulo, fecha: m.fecha, empresa: m.company_name } : null,
    firmas,
  });
});

module.exports = router;
