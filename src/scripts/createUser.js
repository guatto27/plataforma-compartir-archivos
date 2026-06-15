'use strict';

/*
 * Crea un usuario desde la línea de comandos.
 *
 * Uso:
 *   node src/scripts/createUser.js <role> <username> <password> [nombre]
 *
 * Ejemplos:
 *   node src/scripts/createUser.js admin marco "MiClaveSuperSegura10+"
 *   node src/scripts/createUser.js client acme "ClaveTemporal123" "ACME S.A."
 *
 * Nota: los administradores creados por aquí NO se ven forzados a cambiar
 * la contraseña; los clientes sí (deben cambiarla en su primer acceso).
 */

const bcrypt = require('bcryptjs');
const { db } = require('../db');

const [, , roleArg, usernameArg, passwordArg, displayArg] = process.argv;

function fail(msg) {
  console.error('\n  ERROR: ' + msg + '\n');
  console.error('  Uso: node src/scripts/createUser.js <role> <username> <password> [nombre]\n');
  process.exit(1);
}

const role = String(roleArg || '').toLowerCase();
const username = String(usernameArg || '').trim().toLowerCase();
const password = String(passwordArg || '');
const display = String(displayArg || '').trim();

if (!['admin', 'client'].includes(role)) fail('El rol debe ser "admin" o "client".');
if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail('Usuario inválido (3-40 caracteres: a-z 0-9 . _ -).');
if (password.length < 10) fail('La contraseña debe tener al menos 10 caracteres.');

const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (exists) fail('Ese usuario ya existe.');

const hash = bcrypt.hashSync(password, 12);
const mustChange = role === 'client' ? 1 : 0;

db.prepare(
  `INSERT INTO users (username, password_hash, role, display_name, must_change_password)
   VALUES (?, ?, ?, ?, ?)`
).run(username, hash, role, display || username, mustChange);

console.log(`\n  ✓ Usuario "${username}" (${role}) creado correctamente.\n`);
process.exit(0);
