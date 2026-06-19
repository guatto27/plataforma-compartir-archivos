'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Asegura que la carpeta de datos exista
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);

// Mejoras de robustez/seguridad de SQLite
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'client', 'colaborador', 'cliente_responsable')),
    display_name TEXT,
    company_name TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('to_client', 'to_admin')),
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT,
    size INTEGER,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS interview_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS interviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    cargo TEXT,
    area TEXT,
    interview_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_files_client ON files(client_id);
  CREATE INDEX IF NOT EXISTS idx_links_client ON interview_links(client_id);
  CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(file_id);
  CREATE INDEX IF NOT EXISTS idx_interviews_client ON interviews(client_id);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migración: relacionar archivos con una entrevista (columna añadida si no existe)
const fileCols = db.prepare('PRAGMA table_info(files)').all();
if (!fileCols.some((c) => c.name === 'interview_id')) {
  db.exec('ALTER TABLE files ADD COLUMN interview_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_interview ON files(interview_id)');
}

// Migración: vincular cada usuario a una empresa (columna añadida si no existe)
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some((c) => c.name === 'company_id')) {
  db.exec('ALTER TABLE users ADD COLUMN company_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)');
}
// Migración: correo electrónico del usuario (para el correo de bienvenida)
if (!userCols.some((c) => c.name === 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
}

// Migración: permitir el rol 'colaborador'. En bases creadas con el CHECK
// antiguo (solo admin/client) se reconstruye la tabla users preservando datos.
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
if (usersSql && usersSql.sql && !usersSql.sql.includes("'cliente_responsable'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'client', 'colaborador', 'cliente_responsable')),
    display_name TEXT,
    company_name TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    company_id INTEGER,
    email TEXT
  )`);
  db.exec(
    `INSERT INTO users_new (id, username, password_hash, role, display_name, company_name, must_change_password, active, created_at, company_id, email)
     SELECT id, username, password_hash, role, display_name, company_name, must_change_password, active, created_at, company_id, email FROM users`
  );
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)');
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[migración] tabla users actualizada para admitir el rol "colaborador".');
}

// Bootstrap: crea un administrador inicial desde variables de entorno si aún
// no existe. Útil en despliegues (Hostinger, etc.) donde la BD arranca vacía.
// Es idempotente: solo crea la cuenta si ese usuario no existe.
(function seedAdminFromEnv() {
  const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || password.length < 8) return;
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return;
  try {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(password, 12);
    db.prepare(
      `INSERT INTO users (username, password_hash, role, display_name, must_change_password)
       VALUES (?, ?, 'admin', ?, 0)`
    ).run(username, hash, username);
    console.log(`[seed] Administrador inicial "${username}" creado desde variables de entorno.`);
  } catch (err) {
    console.error('[seed] No se pudo crear el admin inicial:', err.message);
  }
})();

function logAction(userId, action, detail, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?, ?, ?, ?)'
    ).run(userId ?? null, action, detail ?? null, ip ?? null);
  } catch (err) {
    // El registro de auditoría nunca debe tumbar la app
    console.error('audit log error:', err.message);
  }
}

module.exports = { db, logAction };
