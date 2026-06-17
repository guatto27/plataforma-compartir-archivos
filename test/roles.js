'use strict';

// Verifica el rol "colaborador": puede ver el área de equipo pero NO dar de
// alta usuarios/empresas. Requiere el servidor en :3000 con admin marco.

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
let ok = 0, fail = 0;
const ck = (n, v) => { v ? ok++ : fail++; console.log((v ? '  ✓ ' : '  ✗ ') + n); };

(async () => {
  const ts = Date.now().toString().slice(-5);
  // Admin crea un colaborador con contraseña conocida
  const A = jar();
  let r = await get(A, '/login');
  await post(A, '/login', { _csrf: csrf(await r.text()), username: 'marco', password: 'AdminBusinessCool2026' });
  r = await get(A, '/admin/usuarios'); let h = await r.text();
  ck('admin entra a Usuarios', r.status === 200 && h.includes('<h1>Usuarios</h1>'));
  const cu = 'colab' + ts;
  r = await post(A, '/admin/usuarios', { _csrf: csrf(h), role: 'colaborador', company_id: '', username: cu, display_name: 'Colaborador Prueba', password: 'ColabTemporal123' });
  ck('crear colaborador => 302', r.status === 302);
  r = await get(A, '/admin/usuarios'); h = await r.text();
  ck('colaborador aparece con tipo "Colaborador"', h.includes(cu) && h.includes('Colaborador'));

  // El colaborador inicia sesión y cambia su contraseña
  const C = jar();
  r = await get(C, '/login');
  await post(C, '/login', { _csrf: csrf(await r.text()), username: cu, password: 'ColabTemporal123' });
  r = await get(C, '/cambiar-password');
  await post(C, '/cambiar-password', { _csrf: csrf(await r.text()), current: 'ColabTemporal123', next: 'ColabNuevo2026!', confirm: 'ColabNuevo2026!' });

  // Puede ver el área de equipo
  r = await get(C, '/admin'); h = await r.text();
  ck('colaborador ve Entrevistas (200)', r.status === 200 && h.includes('<h1>Entrevistas</h1>'));
  r = await get(C, '/admin/archivos');
  ck('colaborador ve Archivos (200)', r.status === 200);
  r = await get(C, '/admin/usuarios'); h = await r.text();
  ck('colaborador ve lista de Usuarios (200)', r.status === 200 && h.includes('<h1>Usuarios</h1>'));
  ck('colaborador NO ve botón "+ Nuevo usuario"', !h.includes('dlg-new-user'));
  r = await get(C, '/admin/empresas'); h = await r.text();
  ck('colaborador ve Empresas (200)', r.status === 200);
  ck('colaborador NO ve botón "+ Nueva empresa"', !h.includes('dlg-new-company'));

  // NO puede dar de alta usuarios ni empresas (403)
  r = await get(C, '/admin'); const ctok = csrf(await r.text());
  r = await post(C, '/admin/usuarios', { _csrf: ctok, role: 'colaborador', username: 'hack' + ts, password: 'x' });
  ck('colaborador NO puede crear usuario (403)', r.status === 403);
  r = await post(C, '/admin/empresas', { _csrf: ctok, name: 'HackCorp' + ts });
  ck('colaborador NO puede crear empresa (403)', r.status === 403);

  // Limpieza (admin borra el colaborador)
  r = await get(A, '/admin/usuarios'); h = await r.text();
  const before = h.slice(0, h.indexOf(cu));
  const ids = [...before.matchAll(/\/admin\/usuarios\/(\d+)/g)];
  const cid = ids.length ? ids[ids.length - 1][1] : null;
  if (cid) await post(A, '/admin/usuarios/' + cid + '/delete', { _csrf: csrf(h) });

  console.log('\n  ' + ok + ' ok, ' + fail + ' fallos\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
