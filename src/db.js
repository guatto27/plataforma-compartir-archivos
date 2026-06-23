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

  CREATE TABLE IF NOT EXISTS minutas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    company_name TEXT,
    titulo TEXT NOT NULL,
    fecha TEXT NOT NULL,
    formato TEXT NOT NULL DEFAULT 'ejecutiva',
    transcripcion TEXT,
    contenido TEXT,
    archivo_path TEXT,
    archivo_nombre TEXT,
    firmada INTEGER NOT NULL DEFAULT 0,
    firma_serial TEXT,
    firma_nombre TEXT,
    firma_fecha TEXT,
    publicada INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Vigente',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);
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

// Migración: logo y proyecto de la empresa
const companyCols = db.prepare('PRAGMA table_info(companies)').all();
if (!companyCols.some((c) => c.name === 'logo_path')) {
  db.exec('ALTER TABLE companies ADD COLUMN logo_path TEXT');
}
if (!companyCols.some((c) => c.name === 'project')) {
  db.exec('ALTER TABLE companies ADD COLUMN project TEXT');
}
if (!companyCols.some((c) => c.name === 'eslogan')) {
  db.exec('ALTER TABLE companies ADD COLUMN eslogan TEXT');
}
if (!companyCols.some((c) => c.name === 'eslogan_path')) {
  db.exec('ALTER TABLE companies ADD COLUMN eslogan_path TEXT');
}
if (!companyCols.some((c) => c.name === 'project_status')) {
  db.exec("ALTER TABLE companies ADD COLUMN project_status TEXT DEFAULT 'Vigente'");
}

// Migración: columnas de archivo adjunto y firma en minutas
const minutaCols = db.prepare('PRAGMA table_info(minutas)').all();
const minutaHas = (col) => minutaCols.some((c) => c.name === col);
if (!minutaHas('archivo_path'))          db.exec('ALTER TABLE minutas ADD COLUMN archivo_path TEXT');
if (!minutaHas('archivo_nombre'))        db.exec('ALTER TABLE minutas ADD COLUMN archivo_nombre TEXT');
if (!minutaHas('firma_folio'))           db.exec('ALTER TABLE minutas ADD COLUMN firma_folio TEXT');
if (!minutaHas('firma_email'))           db.exec('ALTER TABLE minutas ADD COLUMN firma_email TEXT');
if (!minutaHas('firma_rfc'))             db.exec('ALTER TABLE minutas ADD COLUMN firma_rfc TEXT');
if (!minutaHas('firmada_cliente'))       db.exec('ALTER TABLE minutas ADD COLUMN firmada_cliente INTEGER NOT NULL DEFAULT 0');
if (!minutaHas('firma_cliente_serial'))  db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_serial TEXT');
if (!minutaHas('firma_cliente_nombre'))  db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_nombre TEXT');
if (!minutaHas('firma_cliente_fecha'))   db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_fecha TEXT');
if (!minutaHas('firma_cliente_folio'))   db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_folio TEXT');
if (!minutaHas('firma_cliente_email'))   db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_email TEXT');
if (!minutaHas('firma_cliente_rfc'))     db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_rfc TEXT');
// Verificación criptográfica (sello + hash + certificado por firmante)
if (!minutaHas('firma_hash'))            db.exec('ALTER TABLE minutas ADD COLUMN firma_hash TEXT');
if (!minutaHas('firma_sello'))           db.exec('ALTER TABLE minutas ADD COLUMN firma_sello TEXT');
if (!minutaHas('firma_cert'))            db.exec('ALTER TABLE minutas ADD COLUMN firma_cert TEXT');
if (!minutaHas('firma_cliente_hash'))    db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_hash TEXT');
if (!minutaHas('firma_cliente_sello'))   db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_sello TEXT');
if (!minutaHas('firma_cliente_cert'))    db.exec('ALTER TABLE minutas ADD COLUMN firma_cliente_cert TEXT');
// Fila de firma detectada (JSON {page,y}) para alinear admin y cliente
if (!minutaHas('firma_slots'))           db.exec('ALTER TABLE minutas ADD COLUMN firma_slots TEXT');
// Multi-proyecto: a qué proyecto pertenece la minuta
if (!minutaHas('project_id'))            db.exec('ALTER TABLE minutas ADD COLUMN project_id INTEGER');

// Migración: contrato del proyecto (PDF) + firma e.firma de BusinessCool y del cliente
const projCols = db.prepare('PRAGMA table_info(projects)').all();
const projHas = (n) => projCols.some((c) => c.name === n);
const addProj = (n, type) => { if (!projHas(n)) db.exec(`ALTER TABLE projects ADD COLUMN ${n} ${type}`); };
addProj('contrato_path', 'TEXT');
addProj('contrato_nombre', 'TEXT');
addProj('contrato_enviado', 'INTEGER NOT NULL DEFAULT 0');
// Firma BusinessCool
addProj('cont_firmada', 'INTEGER NOT NULL DEFAULT 0');
['serial', 'nombre', 'fecha', 'folio', 'email', 'rfc', 'hash', 'sello', 'cert', 'slots']
  .forEach((s) => addProj('cont_firma_' + s, 'TEXT'));
// Firma cliente
addProj('cont_firmada_cliente', 'INTEGER NOT NULL DEFAULT 0');
['serial', 'nombre', 'fecha', 'folio', 'email', 'rfc', 'hash', 'sello', 'cert']
  .forEach((s) => addProj('cont_fc_' + s, 'TEXT'));

// Migración: a qué proyecto pertenece cada entrevista (los archivos heredan el proyecto vía su entrevista)
const interviewCols = db.prepare('PRAGMA table_info(interviews)').all();
if (!interviewCols.some((c) => c.name === 'project_id')) {
  db.exec('ALTER TABLE interviews ADD COLUMN project_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_interviews_project ON interviews(project_id)');
}

// Migración: a partir del campo de texto company.project (modelo de 1 proyecto por
// empresa) creamos el primer registro real en la tabla projects y reasignamos las
// minutas/entrevistas existentes de esa empresa a ese proyecto. Idempotente: solo
// corre para empresas que aún no tienen ningún proyecto registrado.
(function seedProjectsFromCompanies() {
  const companies = db.prepare('SELECT id, project, project_status FROM companies').all();
  const countFor = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE company_id = ?');
  const insertProj = db.prepare('INSERT INTO projects (company_id, name, status) VALUES (?, ?, ?)');
  const tagMinutas = db.prepare('UPDATE minutas SET project_id = ? WHERE company_id = ? AND project_id IS NULL');
  const tagInterviews = db.prepare(
    'UPDATE interviews SET project_id = ? WHERE project_id IS NULL AND client_id IN (SELECT id FROM users WHERE company_id = ?)'
  );
  for (const c of companies) {
    if (!c.project || !String(c.project).trim()) continue; // sin proyecto de texto → nada que migrar
    if (countFor.get(c.id).n > 0) continue;                // ya tiene proyectos → no duplicar
    const r = insertProj.run(c.id, String(c.project).trim(), c.project_status || 'Vigente');
    const pid = r.lastInsertRowid;
    tagMinutas.run(pid, c.id);
    tagInterviews.run(pid, c.id);
  }
})();

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
