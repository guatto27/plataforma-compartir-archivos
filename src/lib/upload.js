'use strict';

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    // Nombre aleatorio en disco; el nombre original se guarda en la BD
    const ext = path.extname(file.originalname).toLowerCase();
    const random = crypto.randomBytes(16).toString('hex');
    cb(null, `${random}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (config.allowedExt.includes(ext)) return cb(null, true);
  cb(new Error(`Tipo de archivo no permitido (.${ext}). Permitidos: ${config.allowedExt.join(', ')}`));
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileBytes, files: 10 },
});

module.exports = { upload };
