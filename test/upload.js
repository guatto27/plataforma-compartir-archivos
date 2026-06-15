'use strict';

// Verifica las reglas de subida: acepta tipos válidos (incl. video/audio)
// y rechaza extensiones no permitidas. Requiere el servidor en :3000.
// Uso: node test/upload.js

const BASE = 'http://localhost:3000';
let cookie = '';

function saveCookie(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const pair = c.split(';')[0];
    if (pair.startsWith('bc.sid=')) cookie = pair;
  }
}
const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1] || null;

async function get(path) {
  const res = await fetch(BASE + path, { headers: { cookie }, redirect: 'manual' });
  saveCookie(res);
  return res;
}
async function postForm(path, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body, redirect: 'manual',
  });
  saveCookie(res);
  return res;
}
async function postUpload(path, csrf, filename, type, bytes) {
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('description', 'prueba');
  fd.append('files', new Blob([bytes], { type }), filename);
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { cookie }, body: fd, redirect: 'manual',
  });
  saveCookie(res);
  return res;
}

let pass = 0, failCount = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { failCount++; console.log('  ✗ ' + n); } };

(async () => {
  // login admin
  let res = await get('/login');
  let csrf = csrfFrom(await res.text());
  await postForm('/login', { _csrf: csrf, username: 'marco', password: 'AdminBusinessCool2026' });

  // crear cliente con contraseña conocida
  res = await get('/admin/gestion');
  let html = await res.text();
  csrf = csrfFrom(html);
  const uname = 'vid' + Date.now().toString().slice(-5);
  await postForm('/admin/clients', {
    _csrf: csrf, username: uname, display_name: 'Test Video', company_name: 'X', password: 'ClienteTemporal123',
  });

  // localizar id del cliente recién creado
  res = await get('/admin/gestion');
  html = await res.text();
  const re = new RegExp('/admin/clients/(\\d+)"[^>]*>\\s*<strong>Test Video');
  const m = html.match(/\/admin\/clients\/(\d+)/g);
  // tomamos el primero (más reciente, orden DESC)
  const clientId = m ? m[0].split('/').pop() : null;
  check('cliente creado y con id', !!clientId);

  // subir un .mp4 (debe aceptarse)
  res = await get('/admin/clients/' + clientId);
  csrf = csrfFrom(await res.text());
  res = await postUpload('/admin/clients/' + clientId + '/upload', csrf, 'demo.mp4', 'video/mp4', Buffer.from('fake-video-bytes'));
  check('subida de .mp4 aceptada (302)', res.status === 302);

  // subir un .mp3 (debe aceptarse)
  res = await get('/admin/clients/' + clientId);
  csrf = csrfFrom(await res.text());
  res = await postUpload('/admin/clients/' + clientId + '/upload', csrf, 'audio.mp3', 'audio/mpeg', Buffer.from('fake-audio'));
  check('subida de .mp3 aceptada (302)', res.status === 302);

  // subir un .exe (debe rechazarse)
  res = await get('/admin/clients/' + clientId);
  csrf = csrfFrom(await res.text());
  res = await postUpload('/admin/clients/' + clientId + '/upload', csrf, 'malo.exe', 'application/octet-stream', Buffer.from('MZ'));
  const body = await res.text();
  check('subida de .exe rechazada (400)', res.status === 400 && body.includes('Tipo de archivo'));

  // confirmar que los archivos válidos aparecen en la ficha
  res = await get('/admin/clients/' + clientId);
  html = await res.text();
  check('demo.mp4 listado', html.includes('demo.mp4'));
  check('audio.mp3 listado', html.includes('audio.mp3'));

  console.log(`\n  Resultado: ${pass} ok, ${failCount} fallos\n`);
  process.exit(failCount ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
