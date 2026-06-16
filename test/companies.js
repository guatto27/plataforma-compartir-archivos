'use strict';

// Verifica Empresas + Usuarios: crear empresa, crear usuario ligado a empresa,
// editar, ficha, y borrado. Requiere el servidor en :3000 con admin marco.

const BASE = 'http://localhost:3000';
let cookie = '';
function setCookie(r) {
  const a = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const x of a) { const p = x.split(';')[0]; if (p.startsWith('bc.sid=')) cookie = p; }
}
const csrf = (h) => (h.match(/name="_csrf" value="([^"]+)"/) || [])[1];
async function get(p) { const r = await fetch(BASE + p, { headers: { cookie }, redirect: 'manual' }); setCookie(r); return r; }
async function post(p, f) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString(), redirect: 'manual' });
  setCookie(r); return r;
}
let ok = 0, fail = 0;
const ck = (n, v) => { v ? ok++ : fail++; console.log((v ? '  ✓ ' : '  ✗ ') + n); };

(async () => {
  let r = await get('/login');
  await post('/login', { _csrf: csrf(await r.text()), username: 'marco', password: 'AdminBusinessCool2026' });

  // Empresas
  r = await get('/admin/empresas'); let h = await r.text();
  ck('GET /admin/empresas (h1 Empresas)', r.status === 200 && h.includes('<h1>Empresas</h1>'));
  const ts = Date.now().toString().slice(-5);
  const cname = 'ACME' + ts;
  r = await post('/admin/empresas', { _csrf: csrf(h), name: cname, contact: 'Juan', notes: 'nota' });
  ck('crear empresa => 302', r.status === 302);
  r = await get('/admin/empresas'); h = await r.text();
  ck('empresa aparece en la tabla', h.includes(cname));

  // Usuarios: localizar company_id en el desplegable
  r = await get('/admin/usuarios'); h = await r.text();
  ck('GET /admin/usuarios (h1 Usuarios)', r.status === 200 && h.includes('<h1>Usuarios</h1>'));
  const cid = (h.match(new RegExp('value="(\\d+)">' + cname)) || [])[1];
  ck('company_id localizado', !!cid);

  // Crear usuario sin empresa => debe fallar (vuelve con error, no crea)
  const uname = 'u' + ts;
  r = await post('/admin/usuarios', { _csrf: csrf(h), company_id: '', username: uname + 'x', display_name: 'X', password: '' });
  r = await get('/admin/usuarios'); h = await r.text();
  ck('usuario sin empresa NO se crea', !h.includes(uname + 'x'));

  // Crear usuario con empresa
  r = await get('/admin/usuarios'); h = await r.text();
  const uemail = uname + '@test.com';
  r = await post('/admin/usuarios', { _csrf: csrf(h), company_id: cid, username: uname, display_name: 'Juan Perez', email: uemail, password: '' });
  ck('crear usuario => 302', r.status === 302);
  r = await get('/admin/usuarios'); h = await r.text();
  ck('credenciales mostradas una vez', h.includes('Contraseña temporal'));
  ck('usuario en la tabla', h.includes(uname));
  ck('empresa del usuario en la tabla', h.includes(cname));
  ck('correo del usuario en la tabla', h.includes(uemail));

  // Ficha del usuario
  const uid = (h.match(/\/admin\/usuarios\/(\d+)"/) || [])[1];
  r = await get('/admin/usuarios/' + uid); h = await r.text();
  ck('ficha de usuario 200', r.status === 200 && h.includes(uname));

  // No se puede borrar empresa con usuarios
  r = await get('/admin/empresas'); h = await r.text();
  r = await post('/admin/empresas/' + cid + '/delete', { _csrf: csrf(h) });
  r = await get('/admin/empresas'); h = await r.text();
  ck('empresa con usuarios NO se borra', h.includes(cname));

  // Borrar usuario, luego empresa
  r = await get('/admin/usuarios'); h = await r.text();
  await post('/admin/usuarios/' + uid + '/delete', { _csrf: csrf(h) });
  r = await get('/admin/usuarios'); h = await r.text();
  ck('usuario eliminado', !h.includes(uname));
  r = await get('/admin/empresas'); h = await r.text();
  await post('/admin/empresas/' + cid + '/delete', { _csrf: csrf(h) });
  await get('/admin/empresas'); // consume el mensaje flash (que incluye el nombre)
  r = await get('/admin/empresas'); h = await r.text();
  ck('empresa eliminada (ya sin usuarios)', !h.includes(cname));

  console.log('\n  ' + ok + ' ok, ' + fail + ' fallos\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
