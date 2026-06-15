'use strict';

// --- Ventanas emergentes (modales) con <dialog> ---
// Abrir: cualquier elemento con data-dialog="id-del-dialog"
// Cerrar: cualquier elemento con [data-close] dentro del dialog, clic en el fondo, o Esc.
document.addEventListener('click', function (e) {
  var opener = e.target.closest('[data-dialog]');
  if (opener) {
    var dlg = document.getElementById(opener.getAttribute('data-dialog'));
    if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
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
