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

// --- Búsqueda dentro de la página (lupa de la barra superior) ---
(function () {
  function getItems() {
    var items = [].slice.call(document.querySelectorAll('[data-search-item]'));
    if (!items.length) items = [].slice.call(document.querySelectorAll('table.table tbody tr'));
    return items;
  }

  function clearHighlights() {
    var root = document.querySelector('.shell-content');
    if (!root) return;
    root.querySelectorAll('mark.bc-hl').forEach(function (m) {
      var parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function highlight(query) {
    clearHighlights();
    var root = document.querySelector('.shell-content');
    if (!root || !query) return;
    var q = query.toLowerCase();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var tag = node.parentNode && node.parentNode.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
        return node.nodeValue.toLowerCase().indexOf(q) !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    var first = null;
    nodes.forEach(function (node) {
      var text = node.nodeValue, lower = text.toLowerCase();
      var frag = document.createDocumentFragment();
      var idx = 0, pos;
      while ((pos = lower.indexOf(q, idx)) !== -1) {
        if (pos > idx) frag.appendChild(document.createTextNode(text.slice(idx, pos)));
        var mark = document.createElement('mark');
        mark.className = 'bc-hl';
        mark.textContent = text.slice(pos, pos + q.length);
        frag.appendChild(mark);
        if (!first) first = mark;
        idx = pos + q.length;
      }
      if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
      if (node.parentNode) node.parentNode.replaceChild(frag, node);
    });
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function runSearch(query) {
    query = (query || '').trim().toLowerCase();
    var items = getItems();
    if (items.length) {
      clearHighlights();
      items.forEach(function (it) {
        var match = !query || it.textContent.toLowerCase().indexOf(query) !== -1;
        it.style.display = match ? '' : 'none';
      });
    } else {
      highlight(query);
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-search-toggle]');
    if (!btn) return;
    var box = btn.closest('[data-search-box]');
    if (!box) return;
    var input = box.querySelector('[data-search-input]');
    var willOpen = !box.classList.contains('open');
    box.classList.toggle('open', willOpen);
    if (willOpen) {
      if (input) input.focus();
    } else if (input) {
      input.value = '';
      runSearch('');
    }
  });

  document.addEventListener('input', function (e) {
    var input = e.target.closest('[data-search-input]');
    if (!input) return;
    runSearch(input.value);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var input = e.target.closest('[data-search-input]');
    if (!input) return;
    input.value = '';
    runSearch('');
    var box = input.closest('[data-search-box]');
    if (box) box.classList.remove('open');
  });
})();
