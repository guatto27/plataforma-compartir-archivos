'use strict';

require('dotenv').config();

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Carpeta de datos persistentes. En un VPS conviene apuntarla a una ruta
// FUERA del directorio de despliegue (p. ej. DATA_DIR=/var/businesscool-data)
// para que la base de datos y los archivos NO se borren en cada actualización.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;

const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  maxFileBytes: (parseInt(process.env.MAX_FILE_MB || '1024', 10)) * 1024 * 1024,
  allowedExt: (process.env.ALLOWED_EXT || 'pdf,doc,docx,odt,rtf,txt,csv,md,xls,xlsx,ods,ppt,pptx,odp,key,png,jpg,jpeg,gif,webp,bmp,svg,heic,tif,tiff,mp3,wav,m4a,aac,ogg,flac,mp4,mov,avi,mkv,webm,wmv,flv,zip,rar,7z')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'data', 'portal.db'),
  uploadsDir: process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(DATA_DIR, 'storage', 'uploads'),
  // Branding — ajusta con los colores reales de BusinessCool IA
  brand: {
    name: 'BusinessCool AI',
    tagline: 'Soluciones en IA',
    website: 'https://businesscool.ai/',
  },
};

if (config.isProd && config.sessionSecret === 'dev-insecure-secret-change-me') {
  throw new Error('SESSION_SECRET no está configurado. Define uno fuerte en .env antes de producción.');
}

module.exports = config;
