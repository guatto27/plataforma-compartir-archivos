'use strict';

// Genera un PDF de minuta con el formato corporativo BusinessCool AI a partir
// de datos estructurados (ver construirDatosMinuta en routes/admin-minutas.js).
// El bloque de firmas usa etiquetas "Por ..." para ser compatible con el
// colocador de e.firma (detectSignatureRow en lib/minuta-firma.js).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 612, PAGE_H = 792;
const MX = 56;                         // margen izquierdo/derecho
const CW = PAGE_W - MX * 2;            // ancho de contenido (500)
const TOP = PAGE_H - 78;              // inicio del contenido (deja sitio al encabezado)
const BOTTOM = 60;                    // límite inferior (deja sitio al pie)

const GOLD  = rgb(0.80, 0.57, 0.06);
const DARK  = rgb(0.13, 0.13, 0.16);
const MUTED = rgb(0.42, 0.42, 0.47);
const LINE  = rgb(0.80, 0.80, 0.84);
const HEADBG = rgb(0.96, 0.94, 0.87);
const ZEBRA  = rgb(0.975, 0.975, 0.985);

// Caracteres que WinAnsi (Helvetica) no soporta → reemplazo seguro.
const KEEP = /[\t\n\r\x20-\x7E\xA0-\xFF–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜]/;
function safe(s) {
  s = String(s == null ? '' : s)
    .replace(/[→⇒➔➤➜]/g, '->')
    .replace(/[✓✔✅☑]/g, '-')
    .replace(/ /g, ' ');
  let out = '';
  for (const ch of s) out += KEEP.test(ch) ? ch : (/[■-◿⁃∙]/.test(ch) ? '•' : '');
  return out;
}

function wrap(text, font, size, maxW) {
  const out = [];
  for (const raw of safe(text).split('\n')) {
    const words = raw.split(/\s+/).filter(Boolean);
    let cur = '';
    if (!words.length) { out.push(''); continue; }
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (!cur || font.widthOfTextAtSize(t, size) <= maxW) cur = t;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

async function renderMinutaPDF(m, data) {
  data = data || {};
  const meta = data.meta || {};
  const pdf = await PDFDocument.create();
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const FB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const FI = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = TOP;
  const newPage = () => { page = pdf.addPage([PAGE_W, PAGE_H]); y = TOP; };
  const ensure = (h) => { if (y - h < BOTTOM) newPage(); };

  function para(text, o = {}) {
    const size = o.size || 10, f = o.f || F, color = o.color || DARK;
    const indent = o.indent || 0, lh = (o.lh || size * 1.34);
    for (const ln of wrap(text, f, size, CW - indent)) {
      ensure(lh);
      page.drawText(ln, { x: MX + indent, y: y - size, size, font: f, color });
      y -= lh;
    }
    y -= (o.gap == null ? 4 : o.gap);
  }

  function bullets(items, o = {}) {
    const size = o.size || 10, lh = size * 1.34;
    for (const it of (items || [])) {
      const lines = wrap(it, F, size, CW - 16);
      lines.forEach((ln, i) => {
        ensure(lh);
        if (i === 0) page.drawText('•', { x: MX + 3, y: y - size, size, font: FB, color: GOLD });
        page.drawText(ln, { x: MX + 16, y: y - size, size, font: F, color: DARK });
        y -= lh;
      });
      y -= 2;
    }
    y -= 2;
  }

  function heading(num, title) {
    ensure(30);
    y -= 8;
    const tx = MX + (num ? 26 : 0);
    if (num) page.drawText(safe(num), { x: MX, y: y - 12, size: 12, font: FB, color: GOLD });
    page.drawText(safe(title), { x: tx, y: y - 12, size: 12, font: FB, color: DARK });
    y -= 17;
    page.drawLine({ start: { x: MX, y }, end: { x: MX + CW, y }, thickness: 0.6, color: LINE });
    y -= 9;
  }

  // Tabla con anchos relativos (fracciones que suman 1). header: array; rows: array de arrays
  function table(header, rows, fracs) {
    const widths = fracs.map((f) => f * CW);
    const size = 9, padX = 5, padY = 4.5, lh = size * 1.28;
    const rowH = (cells, f) => {
      let mx = 1;
      cells.forEach((c, i) => { mx = Math.max(mx, wrap(c, f, size, widths[i] - padX * 2).length); });
      return mx * lh + padY * 2;
    };
    const drawRow = (cells, opt = {}) => {
      const f = opt.head ? FB : F;
      const h = rowH(cells, f);
      ensure(h + (opt.head ? 0 : 0));
      const top = y;
      if (opt.head) page.drawRectangle({ x: MX, y: top - h, width: CW, height: h, color: HEADBG });
      else if (opt.zebra) page.drawRectangle({ x: MX, y: top - h, width: CW, height: h, color: ZEBRA });
      let x = MX;
      cells.forEach((c, i) => {
        wrap(c, f, size, widths[i] - padX * 2).forEach((ln, li) => {
          page.drawText(ln, { x: x + padX, y: top - padY - size - li * lh, size, font: f, color: DARK });
        });
        x += widths[i];
      });
      page.drawLine({ start: { x: MX, y: top - h }, end: { x: MX + CW, y: top - h }, thickness: 0.5, color: LINE });
      y = top - h;
    };
    ensure(rowH(header, FB) + 18);
    page.drawLine({ start: { x: MX, y }, end: { x: MX + CW, y }, thickness: 0.5, color: LINE });
    drawRow(header, { head: true });
    rows.forEach((r, i) => drawRow(r, { zebra: i % 2 === 1 }));
    y -= 10;
  }

  // ── Portada / título (página 1) ──────────────────────────────────────────
  page.drawText('MINUTA DE REUNION', { x: MX, y: y - 22, size: 22, font: FB, color: DARK });
  y -= 34;
  if (data.subtitulo) para(data.subtitulo, { size: 12, f: FB, color: GOLD, gap: 2 });
  const cruz = (m.company_name ? m.company_name + '  x  ' : '') + 'BusinessCool AI';
  para(cruz, { size: 11, color: MUTED, gap: 10 });

  // Tabla de metadatos (etiqueta / valor)
  const metaRows = [];
  if (meta.proyecto)   metaRows.push(['Proyecto', meta.proyecto]);
  if (meta.no_minuta)  metaRows.push(['No. de minuta', meta.no_minuta]);
  if (m.fecha)         metaRows.push(['Fecha', m.fecha]);
  if (meta.horario)    metaRows.push(['Horario', meta.horario]);
  if (meta.modalidad)  metaRows.push(['Modalidad', meta.modalidad]);
  if (meta.tipo_sesion) metaRows.push(['Tipo de sesion', meta.tipo_sesion]);
  if (m.company_name)  metaRows.push(['Empresa', m.company_name]);
  if (metaRows.length) { table(['Campo', 'Detalle'], metaRows, [0.26, 0.74]); }

  // ── Asistentes ───────────────────────────────────────────────────────────
  const asis = data.asistentes || {};
  const bcA = asis.businesscool || [], clA = asis.cliente || [];
  if (bcA.length || clA.length) {
    heading('01', 'Asistentes');
    if (bcA.length) {
      para('Por BusinessCool AI:', { size: 10, f: FB, gap: 3 });
      table(['Integrante', 'Rol en el proyecto'], bcA.map((p) => [p.nombre || '', p.rol || '']), [0.42, 0.58]);
    }
    if (clA.length) {
      para('Por ' + (m.company_name || 'el cliente') + ':', { size: 10, f: FB, gap: 3 });
      table(['Integrante', 'Rol en el proyecto'], clA.map((p) => [p.nombre || '', p.rol || '']), [0.42, 0.58]);
    }
  }

  // ── Secciones numeradas ──────────────────────────────────────────────────
  let n = (bcA.length || clA.length) ? 2 : 1;
  for (const sec of (data.secciones || [])) {
    if (!sec || (!sec.titulo && !(sec.parrafos || []).length && !(sec.vinetas || []).length)) continue;
    heading(String(n).padStart(2, '0'), sec.titulo || 'Sección');
    for (const p of (sec.parrafos || [])) para(p, { size: 10 });
    if ((sec.vinetas || []).length) bullets(sec.vinetas);
    n++;
  }

  // ── Acuerdos ─────────────────────────────────────────────────────────────
  if ((data.acuerdos || []).length) {
    heading(String(n).padStart(2, '0'), 'Acuerdos'); n++;
    bullets(data.acuerdos);
  }

  // ── Tareas / compromisos ─────────────────────────────────────────────────
  const tareas = data.tareas || [];
  const tBC = tareas.filter((t) => (t.parte || '').toLowerCase().includes('business') || /^bc/i.test(t.id || ''));
  const tCL = tareas.filter((t) => !tBC.includes(t));
  const tareaTable = (titulo, arr) => {
    if (!arr.length) return;
    heading(String(n).padStart(2, '0'), titulo); n++;
    table(['ID', 'Tarea / compromiso', 'Responsable', 'Fecha'],
      arr.map((t) => [t.id || '', t.tarea || '', t.responsable || '', t.fecha || '']),
      [0.09, 0.52, 0.23, 0.16]);
  };
  tareaTable('Tareas — BusinessCool AI', tBC);
  tareaTable('Tareas — ' + (m.company_name || 'Cliente'), tCL);

  // ── Bloque de validación / firmas (compatible con e.firma) ───────────────
  const firmas = data.firmas || {};
  const bcFirma = firmas.businesscool || {};
  const clFirma = firmas.cliente || {};
  const bcNom = bcFirma.nombre || (bcA[0] && bcA[0].nombre) || 'BusinessCool AI';
  const bcRol = bcFirma.rol || (bcA[0] && bcA[0].rol) || 'Direccion del proyecto';
  const clNom = clFirma.nombre || (clA[0] && clA[0].nombre) || (m.company_name || 'Cliente');
  const clRol = clFirma.rol || (clA[0] && clA[0].rol) || 'Representante';

  heading(String(n).padStart(2, '0'), 'Validacion de la minuta');
  para('Esta minuta documenta los temas y acuerdos tratados. De no recibirse observaciones por los canales acordados, se tendra por validada.', { size: 10, color: MUTED, gap: 10 });

  // Necesitamos espacio para el sello (QR ~112pt sobre la etiqueta "Por ...")
  ensure(170);
  y -= 120; // espacio reservado para los sellos de e.firma
  const colL = MX, colR = MX + CW / 2 + 10;
  // líneas de firma
  page.drawLine({ start: { x: colL, y }, end: { x: colL + CW / 2 - 24, y }, thickness: 0.7, color: LINE });
  page.drawLine({ start: { x: colR, y }, end: { x: colR + CW / 2 - 24, y }, thickness: 0.7, color: LINE });
  y -= 14;
  // Etiquetas "Por ..." (misma altura) — claves para el colocador de e.firma
  page.drawText('Por BusinessCool AI', { x: colL, y: y - 10, size: 10, font: FB, color: DARK });
  page.drawText('Por ' + safe(m.company_name || clNom), { x: colR, y: y - 10, size: 10, font: FB, color: DARK });
  y -= 16;
  page.drawText(safe(bcNom + (bcRol ? ' — ' + bcRol : '')), { x: colL, y: y - 9, size: 9, font: F, color: MUTED });
  page.drawText(safe(clNom + (clRol ? ' — ' + clRol : '')), { x: colR, y: y - 9, size: 9, font: F, color: MUTED });

  // ── Encabezado y pie en todas las páginas ────────────────────────────────
  const pages = pdf.getPages();
  const total = pages.length;
  pages.forEach((pg, i) => {
    // Encabezado
    pg.drawText('BUSINESSCOOL', { x: MX, y: PAGE_H - 42, size: 11, font: FB, color: DARK });
    pg.drawText(' IA', { x: MX + FB.widthOfTextAtSize('BUSINESSCOOL', 11), y: PAGE_H - 42, size: 11, font: FB, color: GOLD });
    const site = 'businesscool.ai';
    pg.drawText(site, { x: PAGE_W - MX - F.widthOfTextAtSize(site, 9), y: PAGE_H - 42, size: 9, font: F, color: MUTED });
    pg.drawLine({ start: { x: MX, y: PAGE_H - 50 }, end: { x: PAGE_W - MX, y: PAGE_H - 50 }, thickness: 0.6, color: LINE });
    // Pie
    pg.drawLine({ start: { x: MX, y: 48 }, end: { x: PAGE_W - MX, y: 48 }, thickness: 0.5, color: LINE });
    const ftxt = 'Confidencial - Uso interno y cliente autorizado - businesscool.ai';
    pg.drawText(ftxt, { x: MX, y: 36, size: 7, font: F, color: MUTED });
    const pg2 = 'Pagina ' + (i + 1) + ' de ' + total;
    pg.drawText(pg2, { x: PAGE_W - MX - F.widthOfTextAtSize(pg2, 7), y: 36, size: 7, font: F, color: MUTED });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { renderMinutaPDF };
