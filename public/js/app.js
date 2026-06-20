'use strict';

// Carrusel: botones ‹ › que desplazan el track horizontalmente
document.addEventListener('click', function (e) {
  var nav = e.target.closest('[data-carousel]');
  if (!nav) return;
  var track = nav.parentElement.querySelector('.pipeline, .steps');
  if (!track) return;
  var amount = 338; // ancho de tarjeta + separación
  track.scrollBy({ left: nav.getAttribute('data-carousel') === 'next' ? amount : -amount, behavior: 'smooth' });
});

// --- Ventanas emergentes (modales) con <dialog> ---
// Abrir: cualquier elemento con data-dialog="id-del-dialog"
// Cerrar: cualquier elemento con [data-close] dentro del dialog, clic en el fondo, o Esc.
document.addEventListener('click', function (e) {
  var opener = e.target.closest('[data-dialog]');
  if (opener) {
    var dlg = document.getElementById(opener.getAttribute('data-dialog'));
    if (dlg && typeof dlg.showModal === 'function') {
      dlg.showModal();
      // Carga la vista previa del PDF solo al abrir (lazy)
      var obj = dlg.querySelector('object[data-pdf-src]');
      if (obj && !obj.getAttribute('data')) obj.setAttribute('data', obj.getAttribute('data-pdf-src'));
      // Cierra el menú de usuario si el diálogo se abrió desde ahí
      document.querySelectorAll('details.usermenu[open]').forEach(function (d) { d.removeAttribute('open'); });
    }
    return;
  }
  var closer = e.target.closest('[data-close]');
  if (closer) {
    var d = closer.closest('dialog');
    if (d) d.close();
    return;
  }
  // Clic en el fondo cierra, salvo dialogs marcados con data-strict
  if (e.target.tagName === 'DIALOG' && !e.target.hasAttribute('data-strict')) {
    e.target.close();
  }
});

document.addEventListener('DOMContentLoaded', function () {
  // Abrir automáticamente un dialog marcado con data-autoopen
  var auto = document.querySelector('dialog[data-autoopen]');
  if (auto && typeof auto.showModal === 'function') auto.showModal();

  // Dialogs data-strict: la tecla Esc no los cierra (solo sus botones)
  document.querySelectorAll('dialog[data-strict]').forEach(function (d) {
    d.addEventListener('cancel', function (e) { e.preventDefault(); });
  });
});

// Cerrar el menú de usuario (<details class="usermenu">) al hacer clic fuera
document.addEventListener('click', function (e) {
  document.querySelectorAll('details.usermenu[open]').forEach(function (d) {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});

// Confirmación antes de enviar un formulario con data-confirm="mensaje"
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (form && form.getAttribute && form.getAttribute('data-confirm')) {
    if (!window.confirm(form.getAttribute('data-confirm'))) {
      e.preventDefault();
    }
  }
});

// Ojo para mostrar/ocultar contraseña (botón con data-pw-toggle="input-id")
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-pw-toggle]');
  if (!btn) return;
  var inp = document.getElementById(btn.getAttribute('data-pw-toggle'));
  if (!inp) return;
  var isHidden = inp.type === 'password';
  inp.type = isHidden ? 'text' : 'password';
  var showSvg = btn.querySelector('.eye-show');
  var hideSvg = btn.querySelector('.eye-hide');
  if (showSvg) showSvg.style.display = isHidden ? 'none' : '';
  if (hideSvg) hideSvg.style.display = isHidden ? '' : 'none';
});

// Árbol de fases: un summary con data-href navega al hacer clic en el título;
// el caret (data-tree-toggle) sigue plegando/desplegando.
document.addEventListener('click', function (e) {
  var summary = e.target.closest('.sidebar-tree details > summary');
  if (!summary) return;
  var href = summary.getAttribute('data-href');
  if (!href) return;                                   // fases sin página: comportamiento normal (toggle)
  if (e.target.closest('[data-tree-toggle]')) return;  // clic en el caret → dejar que pliegue/despliegue
  e.preventDefault();                                  // evita que el <details> alterne
  window.location.href = href;
});

// Selector que envía su formulario al cambiar (p. ej. selector de proyecto)
document.addEventListener('change', function (e) {
  var sel = e.target.closest('select[data-autosubmit]');
  if (sel && sel.form) sel.form.submit();
});

// Toggle de paneles con radio buttons (data-toggle-target / data-toggle-group)
document.addEventListener('change', function (e) {
  var radio = e.target.closest('input[type=radio][data-toggle-target]');
  if (!radio) return;
  var group = radio.getAttribute('data-toggle-group');
  // Ocultar todos los paneles del grupo
  document.querySelectorAll('input[type=radio][data-toggle-group="' + group + '"]').forEach(function (r) {
    var panel = document.getElementById(r.getAttribute('data-toggle-target'));
    if (panel) panel.style.display = 'none';
  });
  // Mostrar el panel del radio activo
  var activePanel = document.getElementById(radio.getAttribute('data-toggle-target'));
  if (activePanel) activePanel.style.display = '';
  // Ajustar el texto/visibilidad del botón generar si existe
  var btnGenerar = document.getElementById('btn-generar');
  if (btnGenerar) btnGenerar.style.display = radio.value === 'archivo' ? 'none' : '';
});

// Copiar credenciales al portapapeles (botón con data-copy="id1|id2")
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var ids = btn.getAttribute('data-copy').split('|');
  var parts = ids.map(function (id) {
    var el = document.getElementById(id);
    return el ? el.textContent.trim() : '';
  });
  var text = '';
  if (ids.length === 2) {
    text = 'Usuario: ' + parts[0] + '\nContraseña: ' + parts[1];
  } else {
    text = parts.join(' ');
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function () {
      var original = btn.textContent;
      btn.textContent = 'Copiado ✓';
      setTimeout(function () { btn.textContent = original; }, 1800);
    });
  }
});

// --- Tema claro / oscuro ---
function bcCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function bcUpdateThemeLabels() {
  var t = bcCurrentTheme();
  document.querySelectorAll('[data-theme-label]').forEach(function (el) {
    el.textContent = t === 'light' ? 'Claro' : 'Oscuro';
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-theme-toggle]');
  if (!b) return;
  e.preventDefault();
  var next = bcCurrentTheme() === 'light' ? 'dark' : 'light';
  if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('bc-theme', next); } catch (_) {}
  bcUpdateThemeLabels();
});
document.addEventListener('DOMContentLoaded', bcUpdateThemeLabels);

// --- Búsqueda global del portal (lupa de la barra superior) ---
// Busca en todas las secciones (según el rol). Al elegir un resultado navega ahí.
(function () {
  var debounceTimer = null;
  var lastResults = [];

  function getParts() {
    var box = document.querySelector('[data-search-box]');
    if (!box) return null;
    return {
      box: box,
      input: box.querySelector('[data-search-input]'),
      panel: box.querySelector('[data-search-results]'),
    };
  }

  function closePanel(p) {
    if (!p || !p.panel) return;
    p.panel.hidden = true;
    p.panel.innerHTML = '';
    lastResults = [];
  }

  function render(p, results) {
    lastResults = results || [];
    if (!results || !results.length) {
      p.panel.innerHTML = '<div class="ts-empty">Sin resultados</div>';
      p.panel.hidden = false;
      return;
    }
    var html = results.map(function (r, i) {
      return '<a class="ts-item' + (i === 0 ? ' active' : '') + '" href="' + r.url + '" data-idx="' + i + '">'
        + '<span class="ts-type">' + r.type + '</span>'
        + '<span class="ts-label">' + escapeHtml(r.label) + '</span>'
        + (r.sub ? '<span class="ts-sub">' + escapeHtml(r.sub) + '</span>' : '')
        + '</a>';
    }).join('');
    p.panel.innerHTML = html;
    p.panel.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function activeIndex(p) {
    var items = p.panel.querySelectorAll('.ts-item');
    for (var i = 0; i < items.length; i++) if (items[i].classList.contains('active')) return i;
    return -1;
  }
  function setActive(p, idx) {
    var items = p.panel.querySelectorAll('.ts-item');
    if (!items.length) return;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    items.forEach(function (it) { it.classList.remove('active'); });
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  function doSearch(query) {
    var p = getParts();
    if (!p) return;
    query = (query || '').trim();
    if (!query) { closePanel(p); return; }
    fetch('/buscar?q=' + encodeURIComponent(query), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : { results: [] }; })
      .then(function (data) { render(p, data.results || []); })
      .catch(function () { closePanel(p); });
  }

  // Abrir/cerrar con la lupa
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-search-toggle]');
    if (!btn) return;
    var p = getParts();
    if (!p) return;
    var willOpen = !p.box.classList.contains('open');
    p.box.classList.toggle('open', willOpen);
    if (willOpen) { if (p.input) p.input.focus(); }
    else { if (p.input) p.input.value = ''; closePanel(p); }
  });

  // Escribir → buscar (con debounce)
  document.addEventListener('input', function (e) {
    var input = e.target.closest('[data-search-input]');
    if (!input) return;
    clearTimeout(debounceTimer);
    var v = input.value;
    debounceTimer = setTimeout(function () { doSearch(v); }, 180);
  });

  // Teclado: flechas para navegar, Enter para ir, Esc para cerrar
  document.addEventListener('keydown', function (e) {
    var input = e.target.closest('[data-search-input]');
    if (!input) return;
    var p = getParts();
    if (!p) return;
    if (e.key === 'Escape') {
      input.value = ''; closePanel(p); p.box.classList.remove('open'); return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(p, activeIndex(p) + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(p, activeIndex(p) - 1); return; }
    if (e.key === 'Enter') {
      var idx = activeIndex(p);
      if (idx < 0) idx = 0;
      if (lastResults[idx]) { e.preventDefault(); window.location.href = lastResults[idx].url; }
    }
  });

  // Cerrar el panel al hacer clic fuera
  document.addEventListener('click', function (e) {
    var p = getParts();
    if (!p) return;
    if (!p.box.contains(e.target)) { closePanel(p); p.box.classList.remove('open'); }
  });
})();
