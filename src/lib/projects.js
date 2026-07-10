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

// Avance por fase de un proyecto. F1 se calcula desde la información requerida
// (puntos entregados o validados / total); F2–F4 son el avance manual del admin.
function phaseProgress(projectId) {
  let f1 = 0;
  const r = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN validado = 1 OR (SELECT COUNT(*) FROM checklist_files f WHERE f.item_id = ci.id) > 0 THEN 1 ELSE 0 END) AS done
     FROM checklist_items ci WHERE project_id = ?`
  ).get(projectId);
  if (r && r.total) f1 = Math.round((r.done / r.total) * 100);
  const p = db.prepare('SELECT fase2_pct, fase3_pct, fase4_pct FROM projects WHERE id = ?').get(projectId) || {};
  const cl = (n) => Math.max(0, Math.min(100, parseInt(n, 10) || 0));
  const f2 = cl(p.fase2_pct), f3 = cl(p.fase3_pct), f4 = cl(p.fase4_pct);
  const overall = Math.round((f1 + f2 + f3 + f4) / 4);
  return { f1, f2, f3, f4, overall };
}

module.exports = { STATUSES, listByCompany, get, counts, activeFor, phaseProgress };
