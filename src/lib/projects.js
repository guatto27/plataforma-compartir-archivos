'use strict';

const { db } = require('../db');

const STATUSES = ['Vigente', 'En pausa', 'Finalizado'];

function listByCompany(companyId) {
  if (!companyId) return [];
  return db
    .prepare('SELECT id, company_id, name, status, created_at FROM projects WHERE company_id = ? ORDER BY created_at, id')
    .all(companyId);
}

function get(id) {
  if (!id) return null;
  return db.prepare('SELECT id, company_id, name, status, created_at FROM projects WHERE id = ?').get(id);
}

// Conteos reales acotados a un proyecto. Los archivos heredan el proyecto vía su entrevista.
function counts(projectId) {
  if (!projectId) return { minutas: 0, interviews: 0, files: 0 };
  const minutas = db.prepare('SELECT COUNT(*) AS n FROM minutas WHERE publicada = 1 AND project_id = ?').get(projectId).n;
  const interviews = db.prepare('SELECT COUNT(*) AS n FROM interviews WHERE project_id = ?').get(projectId).n;
  const files = db
    .prepare('SELECT COUNT(*) AS n FROM files WHERE interview_id IN (SELECT id FROM interviews WHERE project_id = ?)')
    .get(projectId).n;
  return { minutas, interviews, files };
}

// Proyecto activo para un usuario de empresa (cliente). Usa la selección guardada en
// sesión si pertenece a su empresa; si no, cae al primer proyecto de la empresa.
function activeFor(req, companyId) {
  const list = listByCompany(companyId);
  if (!list.length) return null;
  const sel = req.session && req.session.activeProjectId;
  const found = sel && list.find((p) => p.id === sel);
  return found || list[0];
}

module.exports = { STATUSES, listByCompany, get, counts, activeFor };
