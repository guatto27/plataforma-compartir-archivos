'use strict';

// Red neuronal dorada animada (canvas) + contador de conexiones en vivo.
(function () {
  var canvas = document.getElementById('netfx');
  if (canvas && canvas.getContext) {
    var ctx = canvas.getContext('2d');
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    var nodes = [], W = 0, H = 0, N = 0, MAXD = 0;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      var r = canvas.getBoundingClientRect();
      W = canvas.width = Math.max(1, Math.floor(r.width * DPR));
      H = canvas.height = Math.max(1, Math.floor(r.height * DPR));
      N = Math.max(28, Math.min(110, Math.floor((r.width * r.height) / 13000)));
      MAXD = Math.min(W, 170 * DPR);
      nodes = [];
      for (var i = 0; i < N; i++) {
        nodes.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.28 * DPR,
          vy: (Math.random() - 0.5) * 0.28 * DPR,
          r: (Math.random() * 1.6 + 0.7) * DPR,
        });
      }
    }

    function frame() {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < N; i++) {
        var n = nodes[i];
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > W) n.vx *= -1;
        if (n.y < 0 || n.y > H) n.vy *= -1;
      }
      // Conexiones
      for (var a = 0; a < N; a++) {
        for (var b = a + 1; b < N; b++) {
          var p = nodes[a], q = nodes[b];
          var dx = p.x - q.x, dy = p.y - q.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < MAXD) {
            var o = (1 - d / MAXD) * 0.5;
            ctx.strokeStyle = 'rgba(238,196,120,' + o.toFixed(3) + ')';
            ctx.lineWidth = 0.6 * DPR;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
      }
      // Nodos con brillo
      for (var k = 0; k < N; k++) {
        var m = nodes[k];
        var g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 4.5);
        g.addColorStop(0, 'rgba(255,226,150,0.85)');
        g.addColorStop(1, 'rgba(255,200,90,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 4.5, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,236,184,0.95)';
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.2832); ctx.fill();
      }
      if (!reduce) requestAnimationFrame(frame);
    }

    window.addEventListener('resize', resize);
    resize();
    frame();
  }

  // Contador de conexiones en vivo
  var el = document.getElementById('live-count');
  if (el) {
    var v = 1245678;
    var fmt = function (x) { return x.toLocaleString('es-MX'); };
    el.textContent = fmt(v);
    setInterval(function () {
      v += Math.floor(Math.random() * 47) + 3;
      el.textContent = fmt(v);
    }, 1500);
  }
})();
