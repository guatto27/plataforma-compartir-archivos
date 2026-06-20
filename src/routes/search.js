'use strict';

const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

// Páginas/secciones navegables por rol (label + palabras clave + url)
function pagesFor(role) {
  if (role === 'cliente_responsable') {
    return [
      { label: 'Inicio', kw: 'inicio portada bienvenida objetivo', url: '/app/inicio' },
      { label: 'Proyectos', kw: 'proyectos proyecto avance estatus', url: '/app/proyectos' },
      { label: 'Nosotros', kw: 'nosotros quienes somos empresa acerca', url: '/app/nosotros' },
      { label: 'Mi proyecto', kw: 'mi proyecto pipeline fases', url: '/app' },
      { label: 'Entregables', kw: 'entregables archivos documentos', url: '/app/entregables' },
      { label: 'Minutas', kw: 'minutas actas firmas reuniones', url: '/app/minutas' },
      { label: 'Levantamiento', kw: 'levantamiento entrevistas agente requerimientos', url: '/app/agente' },
      { label: 'Archivos', kw: 'archivos documentos files', url: '/app/archivos' },
    ];
  }
  if (role === 'client') {
    return [
      { label: 'Levantamiento', kw: 'levantamiento entrevista agente requerimientos', url: '/app/agente' },
      { label: 'Archivos', kw: 'archivos entregables documentos subir', url: '/app/entregables' },
    ];
  }
  if (role === 'admin') {
    return [
      { label: 'Clientes / Levantamiento', kw: 'clientes levantamiento entrevistas inicio', url: '/admin' },
      { label: 'Archivos', kw: 'archivos documentos files', url: '/admin/archivos' },
      { label: 'Minutas', kw: 'minutas actas firmas', url: '/admin/minutas' },
      { label: 'Empresas / Clientes', kw: 'empresas clientes companias proyectos', url: '/admin/empresas' },
      { label: 'Gestión de Usuarios', kw: 'usuarios accesos cuentas gestion', url: '/admin/usuarios' },
    ];
  }
  if (role === 'colaborador') {
    return [
      { label: 'Clientes', kw: 'clientes entrevistas levantamiento', url: '/admin' },
      { label: 'Archivos', kw: 'archivos documentos files', url: '/admin/archivos' },
      { label: 'Empresas', kw: 'empresas clientes companias', url: '/admin/empresas' },
      { label: 'Usuarios', kw: 'usuarios accesos cuentas', url: '/admin/usuarios' },
    ];
  }
  return [];
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  const role = req.session.role;
  const results = [];

  // 1) Páginas / secciones
  pagesFor(role).forEach((p) => {
    if (p.label.toLowerCase().indexOf(q) !== -1 || p.kw.indexOf(q) !== -1) {
      results.push({ type: 'Página', label: p.label, sub: '', url: p.url });
    }
  });

  const like = '%' + q.replace(/[%_]/g, '') + '%';

  // 2) Datos según rol
  try {
    if (role === 'admin' || role === 'colaborador') {
      db.prepare(
        `SELECT id, name, project, contact FROM companies
         WHERE LOWER(name) LIKE ? OR LOWER(IFNULL(project,'')) LIKE ? OR LOWER(IFNULL(contact,'')) LIKE ?
         ORDER BY name LIMIT 6`
      ).all(like, like, like).forEach((c) => {
        results.push({ type: 'Empresa', label: c.name, sub: c.project || c.contact || '', url: '/admin/empresas' });
      });

      db.prepare(
        `SELECT display_name, username, company_name FROM users
         WHERE LOWER(IFNULL(display_name,'')) LIKE ? OR LOWER(username) LIKE ? OR LOWER(IFNULL(company_name,'')) LIKE ?
         ORDER BY display_name LIMIT 6`
      ).all(like, like, like).forEach((u) => {
        results.push({ type: 'Usuario', label: u.display_name || u.username, sub: u.company_name || '', url: '/admin/usuarios' });
      });
    } else if (role === 'cliente_responsable') {
      const me = db.prepare('SELECT company_id, company_name FROM users WHERE id = ?').get(req.session.userId);
      if (me) {
        db.prepare(
          `SELECT id, archivo_nombre, fecha FROM minutas
           WHERE publicada = 1
             AND (company_id = ? OR (company_id IS NULL AND company_name = ?))
             AND (LOWER(IFNULL(archivo_nombre,'')) LIKE ? OR LOWER(IFNULL(fecha,'')) LIKE ?)
           ORDER BY fecha DESC LIMIT 6`
        ).all(me.company_id || -1, me.company_name || '', like, like).forEach((m) => {
          results.push({ type: 'Minuta', label: m.archivo_nombre || ('Minuta ' + m.id), sub: m.fecha || '', url: '/app/minutas' });
        });
      }
    }
  } catch (e) {
    // Si alguna columna no existe, devolvemos al menos las páginas
  }

  res.json({ results: results.slice(0, 12) });
});

module.exports = router;
