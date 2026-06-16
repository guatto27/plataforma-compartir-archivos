'use strict';

// Prueba de humo: ejercita login, CSRF, sesión y creación de cliente.
// Uso: node test/smoke.js   (con el servidor corriendo en :3000)

const BASE = 'http://localhost:3000';

let cookie = '';

function saveCookie(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const pair = c.split(';')[0];
    if (pair.startsWith('bc.sid=')) cookie = pair;
  }
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { cookie }, redirect: 'manual' });
  saveCookie(res);
  return res;
}

async function post(path, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  saveCookie(res);
  return res;
}

let pass = 0;
let failCount = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failCount++; console.log('  ✗ ' + name); }
}

(async () => {
  // 1. Página de login
  let res = await get('/login');
  let html = await res.text();
  check('GET /login responde 200', res.status === 200);
  let csrf = csrfFrom(html);
  check('login expone token CSRF', !!csrf);

  // 2. Login con credenciales incorrectas
  res = await post('/login', { _csrf: csrf, username: 'marco', password: 'malisima' });
  check('login incorrecto => 401', res.status === 401);

  // 3. POST sin token CSRF => 403
  res = await post('/login', { username: 'marco', password: 'x' });
  check('POST sin CSRF => 403', res.status === 403);

  // 4. Login correcto
  res = await get('/login');
  csrf = csrfFrom(await res.text());
  res = await post('/login', { _csrf: csrf, username: 'marco', password: 'AdminBusinessCool2026' });
  check('login correcto => redirect 302', res.status === 302);

  // 5. Acceder a la página de Archivos (admin)
  res = await get('/admin');
  html = await res.text();
  check('GET /admin => 200 autenticado', res.status === 200);
  check('página muestra "Archivos"', html.includes('Archivos'));
  csrf = csrfFrom(html); // viene del formulario de logout en la cabecera

  // 6. Crear una empresa y luego un usuario ligado a ella
  const ts = Date.now().toString().slice(-5);
  const cname = 'ACME' + ts;
  res = await get('/admin/empresas');
  csrf = csrfFrom(await res.text());
  res = await post('/admin/empresas', { _csrf: csrf, name: cname, contact: '', notes: '' });
  check('crear empresa => redirect 302', res.status === 302);

  res = await get('/admin/usuarios');
  html = await res.text();
  csrf = csrfFrom(html);
  const cid = (html.match(new RegExp('value="(\\d+)">' + cname)) || [])[1];
  check('empresa disponible para asignar', !!cid);

  const uname = 'acme' + ts;
  res = await post('/admin/usuarios', {
    _csrf: csrf,
    company_id: cid,
    username: uname,
    display_name: 'Usuario Prueba',
    password: '',
  });
  check('crear usuario => redirect 302', res.status === 302);

  res = await get('/admin/usuarios');
  html = await res.text();
  check('credenciales generadas se muestran', html.includes('Contraseña temporal'));
  check('usuario aparece en la tabla', html.includes(uname));

  // 7. Cliente no autenticado no puede ver /app
  const savedCookie = cookie;
  cookie = '';
  res = await get('/app');
  check('acceso a /app sin sesión => redirect a login', res.status === 302);
  cookie = savedCookie;

  console.log(`\n  Resultado: ${pass} ok, ${failCount} fallos\n`);
  process.exit(failCount ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
