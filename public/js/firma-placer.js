'use strict';

// Colocador interactivo de la firma sobre el PDF.
// Renderiza el PDF en <canvas> con pdf.js y permite arrastrar un recuadro que
// marca dónde irá la firma. Guarda página + coordenadas normalizadas (fracción
// 0..1, Y desde ARRIBA) en los inputs ocultos del formulario asociado.
//
// Cada colocador es un elemento con clase .pdf-placer y atributos:
//   data-pdf-url="..."  data-form="id-del-formulario"
// El formulario debe contener inputs name="sig_page" / "sig_x" / "sig_y"
// y, opcionalmente, un elemento con [data-placer-hint] para el mensaje.
(function () {
  if (typeof pdfjsLib === 'undefined') return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/js/pdf.worker.min.js';

  // Tamaño del bloque en puntos PDF (debe coincidir con BLOCK_W/BLOCK_H de
  // src/lib/minuta-firma.js). El recuadro se dibuja a ese tamaño real × escala.
  var BLOCK_W = 290, BLOCK_H = 112;
  var drag = null;

  document.addEventListener('mousedown', function (e) {
    var m = e.target.closest('.sig-marker');
    if (!m) return;
    e.preventDefault();
    var wrap = m.parentElement;
    var rect = wrap.getBoundingClientRect();
    drag = { wrap: wrap, marker: m, offX: e.clientX - (rect.left + m.offsetLeft), offY: e.clientY - (rect.top + m.offsetTop) };
  });
  document.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var rect = drag.wrap.getBoundingClientRect();
    var w = drag.wrap.clientWidth, h = drag.wrap.clientHeight;
    var left = Math.max(0, Math.min(e.clientX - rect.left - drag.offX, w - drag.marker.offsetWidth));
    var top = Math.max(0, Math.min(e.clientY - rect.top - drag.offY, h - drag.marker.offsetHeight));
    drag.marker.style.left = left + 'px';
    drag.marker.style.top = top + 'px';
    if (drag.wrap._instance) drag.wrap._instance.save(drag.wrap, left, top);
  });
  document.addEventListener('mouseup', function () { drag = null; });

  function initPlacer(container) {
    var pdfUrl = container.getAttribute('data-pdf-url');
    var form = document.getElementById(container.getAttribute('data-form'));
    if (!pdfUrl || !form) return;

    var inpPage = form.querySelector('[name=sig_page]');
    var inpX = form.querySelector('[name=sig_x]');
    var inpY = form.querySelector('[name=sig_y]');
    var hint = form.querySelector('[data-placer-hint]');
    var pages = [];
    var marker = null;

    var instance = {
      save: function (wrap, left, top) {
        var w = wrap.clientWidth, h = wrap.clientHeight;
        var pageNum = wrap._pageNum;
        if (inpPage) inpPage.value = pageNum;
        if (inpX) inpX.value = (left / w).toFixed(4);
        if (inpY) inpY.value = (top / h).toFixed(4);
        if (hint) { hint.textContent = 'Firma colocada en la página ' + pageNum + '. Arrástrala para ajustar.'; hint.classList.add('ok'); }
      }
    };

    function ensureMarker() {
      if (marker) return marker;
      marker = document.createElement('div');
      marker.className = 'sig-marker';
      marker.innerHTML = '<span>✍ Firma aquí</span>';
      return marker;
    }

    function placeAt(wrap, px, py) {
      var w = wrap.clientWidth, h = wrap.clientHeight;
      var scale = wrap._scale || (w / 595);
      var boxW = Math.min(BLOCK_W * scale, w);   // tamaño real del bloque (pt × escala)
      var boxH = BLOCK_H * scale;
      var left = Math.max(0, Math.min(px - boxW / 2, w - boxW));
      var top = Math.max(0, Math.min(py - boxH / 2, h - boxH));
      var m = ensureMarker();
      m.style.width = boxW + 'px';
      m.style.height = boxH + 'px';
      m.style.left = left + 'px';
      m.style.top = top + 'px';
      if (m.parentElement !== wrap) wrap.appendChild(m);
      instance.save(wrap, left, top);
    }

    pdfjsLib.getDocument(pdfUrl).promise.then(function (pdf) {
      var seq = Promise.resolve();
      for (var n = 1; n <= pdf.numPages; n++) {
        (function (pageNum) {
          seq = seq.then(function () {
            return pdf.getPage(pageNum).then(function (page) {
              var base = page.getViewport({ scale: 1 });
              var scale = Math.min(1.4, (container.clientWidth - 28) / base.width);
              var viewport = page.getViewport({ scale: scale });
              var wrap = document.createElement('div');
              wrap.className = 'pdf-page-wrap';
              wrap.style.width = viewport.width + 'px';
              wrap.style.height = viewport.height + 'px';
              wrap._pageNum = pageNum;
              wrap._instance = instance;
              wrap._scale = scale;
              var canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              wrap.appendChild(canvas);
              container.appendChild(wrap);
              pages.push(wrap);
              wrap.addEventListener('click', function (e) {
                if (e.target.closest('.sig-marker')) return;
                var rect = wrap.getBoundingClientRect();
                placeAt(wrap, e.clientX - rect.left, e.clientY - rect.top);
              });
              return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
            });
          });
        })(n);
      }
      return seq;
    }).catch(function (err) {
      container.innerHTML = '<p style="padding:20px;color:#b33">No se pudo cargar la vista previa: ' + (err && err.message) + '</p>';
    });
  }

  function initAll(root) {
    (root || document).querySelectorAll('.pdf-placer:not([data-init])').forEach(function (c) {
      c.setAttribute('data-init', '1');
      initPlacer(c);
    });
  }

  // Inicializa los visibles al cargar y los que aparezcan al abrir un <details>
  initAll(document);
  document.addEventListener('toggle', function (e) {
    if (e.target.tagName === 'DETAILS' && e.target.open) initAll(e.target);
  }, true);
})();
