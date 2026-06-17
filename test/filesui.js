'use strict';

// Verifica Entrevistas (principal) + Archivos: crear entrevista, link, subir
// archivo asociado, ver, comentar y borrar con permisos. Requiere server en :3000.

const BASE = 'http://localhost:3000';
function jar() {
  let c = '';
  return {
    get c() { return c; },
    set(r) { const a = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const x of a) { const p = x.split(';')[0]; if (p.startsWith('bc.sid=')) c = p; } },
  };
}
const csrf = (h) => (h.match(/name="_csrf" value="([^"]+)"/) || [])[1];
async function get(j, p) { const r = await fetch(BASE + p, { headers: { cookie: j.c }, redirect: 'manual' }); j.set(r); return r; }
async function post(j, p, f) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { cookie: j.c, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString(), redirect: 'manual' });
  j.set(r); return r;
}
async function upload(j, p, csrfTok, name, type, bytes, extra) {
  const fd = new FormData();
  fd.append('_csrf', csrfTok);
  for (const k in (extra || {})) fd.append(k, extra[k]);
  fd.append('files', new Blob([bytes], { type }), name);
  const r = await fetch(BASE + p, { method: 'POST', headers: { cookie: j.c }, body: fd, redirect: 'manual' });
  j.set(r); return r;
}
let ok = 0, fail = 0;
const ck = (n, c) => { c ? ok++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + n); };

(async () => {
  // Admin login + crear cliente con contraseña conocida
  const A = jar();
  let r = await get(A, '/login');
  await post(A, '/login', { _csrf: csrf(await r.text()), username: 'marco', password: 'AdminBusinessCool2026' });
  const persona = 'Ana Zuniga ' + Date.now().toString().slice(-4);
  const u = 'fui' + Date.now().toString().slice(-5);
  const cname = 'EMP' + Date.now().toString().slice(-5);
  // crear empresa
  r = await get(A, '/admin/empresas'); let h = await r.text();
  await post(A, '/admin/empresas', { _csrf: csrf(h), name: cname, contact: '', notes: '' });
  // crear usuario ligado a la empresa
  r = await get(A, '/admin/usuarios'); h = await r.text();
  const cidEmp = (h.match(new RegExp('value="(\\d+)">' + cname)) || [])[1];
  await post(A, '/admin/usuarios', { _csrf: csrf(h), company_id: cidEmp, username: u, display_name: 'FilesUI', password: 'ClienteTemporal123' });

  // El ADMIN crea la entrevista para ese usuario (el usuario ya no las crea).
  // Localizamos el id del usuario por su username único (en la lista de Usuarios).
  await get(A, '/admin/usuarios'); // consume la tarjeta de credenciales
  r = await get(A, '/admin/usuarios'); h = await r.text();
  const uIds = [...h.slice(0, h.indexOf(u)).matchAll(/\/admin\/usuarios\/(\d+)/g)];
  const destId = uIds.length ? uIds[uIds.length - 1][1] : null;
  ck('admin localiza al usuario', !!destId);
  r = await get(A, '/admin'); h = await r.text();
  await post(A, '/admin/interviews', { _csrf: csrf(h), client_id: destId, nombre: persona, cargo: 'Gerente', area: 'Operaciones' });

  // Cliente login + cambio de contraseña forzado
  const C = jar();
  r = await get(C, '/login');
  await post(C, '/login', { _csrf: csrf(await r.text()), username: u, password: 'ClienteTemporal123' });
  r = await get(C, '/cambiar-password');
  await post(C, '/cambiar-password', { _csrf: csrf(await r.text()), current: 'ClienteTemporal123', next: 'ClienteNuevo2026', confirm: 'ClienteNuevo2026' });

  // Entrevistas es la página principal; el usuario VE la entrevista creada por el admin
  r = await get(C, '/app'); h = await r.text();
  ck('cliente: /app es Entrevistas', h.includes('<h1>Entrevistas</h1>'));
  ck('cliente: ve la entrevista creada por el admin', h.includes(persona));
  ck('cliente: NO ve botón Agregar entrevista', !h.includes('dlg-add-interview'));
  const ivid = (h.match(/\/app\/interviews\/(\d+)\/link/) || [])[1];
  ck('cliente: id de entrevista localizado', !!ivid);

  // Guardar link de la entrevista
  await post(C, '/app/interviews/' + ivid + '/link', { _csrf: csrf(h), url: 'https://gemini.google.com/share/demo123' });
  r = await get(C, '/app'); h = await r.text();
  ck('cliente: link guardado (Ver entrevista)', h.includes('Ver entrevista'));

  // Subir un archivo asociado a la entrevista
  r = await get(C, '/app/archivos?entrevista=' + ivid); h = await r.text();
  ck('cliente: Archivos filtrado por entrevista', h.includes(persona));
  await upload(C, '/app/upload', csrf(h), 'plantilla.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('xlsx'), { interview_id: ivid });
  r = await get(C, '/app/archivos?entrevista=' + ivid); h = await r.text();
  ck('cliente: archivo aparece en la entrevista', h.includes('plantilla.xlsx'));

  // En la vista general de Archivos el archivo muestra su entrevista
  r = await get(C, '/app/archivos'); h = await r.text();
  ck('cliente: archivo asociado a "Juan Pérez" en tabla', h.includes('plantilla.xlsx') && h.includes(persona));
  const fid = (h.match(/\/app\/file\/(\d+)\/view/) || [])[1];

  // Visualizar y comentar
  r = await get(C, '/app/file/' + fid + '/view');
  ck('cliente: visualizar => 200', r.status === 200);
  r = await get(C, '/app/file/' + fid + '/comments'); h = await r.text();
  await post(C, '/app/file/' + fid + '/comments', { _csrf: csrf(h), body: 'Comentario de prueba' });
  r = await get(C, '/app/file/' + fid + '/comments'); h = await r.text();
  ck('cliente: comentario guardado', h.includes('Comentario de prueba'));

  // Admin: ve la entrevista y el archivo del cliente
  r = await get(A, '/admin'); h = await r.text();
  ck('admin: ve la entrevista del cliente', h.includes(persona) && h.includes('FilesUI'));
  r = await get(A, '/admin/archivos'); h = await r.text();
  ck('admin: ve el archivo con su cliente y entrevista', h.includes('plantilla.xlsx') && h.includes('FilesUI') && h.includes(persona));

  // Admin NO puede borrar archivo ajeno
  r = await post(A, '/admin/file/' + fid + '/delete', { _csrf: csrf(h) });
  r = await get(A, '/admin/archivos'); h = await r.text();
  ck('admin: no borra archivo ajeno (persiste)', h.includes('plantilla.xlsx'));

  // Admin edita la información del usuario (localiza su id por el usuario único)
  await get(A, '/admin/usuarios'); // primer GET consume la tarjeta de credenciales
  r = await get(A, '/admin/usuarios'); h = await r.text();
  const before = h.slice(0, h.indexOf(u));
  const idMatches = [...before.matchAll(/\/admin\/usuarios\/(\d+)/g)];
  const cid = idMatches.length ? idMatches[idMatches.length - 1][1] : null;
  await post(A, '/admin/usuarios/' + cid + '/edit', { _csrf: csrf(h), company_id: cidEmp, username: u, display_name: 'FilesUI Editado' });
  r = await get(A, '/admin/usuarios/' + cid); h = await r.text();
  ck('admin: edita información del usuario', h.includes('FilesUI Editado'));

  // El usuario NO puede eliminar entrevistas (solo el equipo): debe dar 403
  r = await get(C, '/app'); h = await r.text();
  const delTry = await post(C, '/app/interviews/' + ivid + '/delete', { _csrf: csrf(h) });
  ck('cliente: NO puede eliminar entrevista (403)', delTry.status === 403);
  r = await get(C, '/app'); h = await r.text();
  ck('cliente: la entrevista sigue registrada', h.includes(persona));
  r = await get(C, '/app/archivos'); h = await r.text();
  ck('cliente: su archivo sigue disponible', h.includes('plantilla.xlsx'));

  // El dueño elimina su archivo
  await post(C, '/app/file/' + fid + '/delete', { _csrf: csrf(h) });
  r = await get(C, '/app/archivos'); h = await r.text();
  ck('cliente: dueño elimina su archivo', !h.includes('plantilla.xlsx'));

  console.log('\n  ' + ok + ' ok, ' + fail + ' fallos\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
