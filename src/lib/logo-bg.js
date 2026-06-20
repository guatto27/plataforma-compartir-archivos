'use strict';

const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');

// Quita el fondo SÓLIDO/uniforme (blanco, negro, gris, etc.) de un logo subido,
// mediante relleno por inundación desde los bordes, y lo guarda como PNG
// transparente. Si el logo ya tiene transparencia o no tiene un fondo sólido
// claro, lo deja igual. Devuelve la ruta final (puede cambiar a .png).
async function removeLogoBackground(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg' || ext === '.gif') return filePath; // no procesables aquí

  let img;
  try { img = await Jimp.read(filePath); } catch (_) { return filePath; }

  const w = img.bitmap.width, h = img.bitmap.height, data = img.bitmap.data;
  if (w < 4 || h < 4) return filePath;

  const corner = (x, y) => { const i = (y * w + x) * 4; return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }; };
  const cs = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)];
  // Si alguna esquina ya es (semi)transparente, asumimos fondo ya limpio.
  if (cs.some((c) => c.a < 250)) return filePath;

  const avg = cs.reduce((a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b }), { r: 0, g: 0, b: 0 });
  avg.r /= 4; avg.g /= 4; avg.b /= 4;
  // Las 4 esquinas deben ser de un color parecido (fondo sólido).
  if (!cs.every((c) => Math.abs(c.r - avg.r) < 26 && Math.abs(c.g - avg.g) < 26 && Math.abs(c.b - avg.b) < 26)) return filePath;

  const tol = 42;
  const isBg = (i) => data[i + 3] > 0 &&
    Math.abs(data[i] - avg.r) <= tol && Math.abs(data[i + 1] - avg.g) <= tol && Math.abs(data[i + 2] - avg.b) <= tol;

  // Relleno por inundación desde todos los píxeles del borde (preserva el interior).
  const visited = new Uint8Array(w * h);
  const stackX = [], stackY = [];
  for (let x = 0; x < w; x++) { stackX.push(x, x); stackY.push(0, h - 1); }
  for (let y = 0; y < h; y++) { stackX.push(0, w - 1); stackY.push(y, y); }
  while (stackX.length) {
    const x = stackX.pop(), y = stackY.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const vi = y * w + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    if (!isBg(vi * 4)) continue;
    data[vi * 4 + 3] = 0; // transparente
    stackX.push(x + 1, x - 1, x, x); stackY.push(y, y, y + 1, y - 1);
  }

  const outPath = filePath.slice(0, filePath.length - ext.length) + '.png';
  await img.writeAsync(outPath);
  if (outPath !== filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }
  return outPath;
}

module.exports = { removeLogoBackground };
