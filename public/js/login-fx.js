'use strict';

// Red de nodos dorados que son atraídos al círculo del logo: al acercarse
// emiten un haz de energía, al tocar el círculo desaparecen y lo "cargan"
// (el círculo se ilumina y emite un pulso). Los nodos reaparecen en el borde.
(function () {
  var canvas = document.getElementById('netfx');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var nodes = [], pulses = [], W = 0, H = 0, N = 0, MAXD = 0, ring = null, energy = 0, SZ = 1;

  function spawnEdge() {
    var side = Math.floor(Math.random() * 4), x, y, vx, vy, s = 0.32 * DPR;
    if (side === 0)      { x = Math.random() * W; y = 0;          vx = (Math.random() - .5) * s; vy =  Math.random() * s; }
    else if (side === 1) { x = W;                 y = Math.random() * H; vx = -Math.random() * s; vy = (Math.random() - .5) * s; }
    else if (side === 2) { x = Math.random() * W; y = H;          vx = (Math.random() - .5) * s; vy = -Math.random() * s; }
    else                 { x = 0;                 y = Math.random() * H; vx =  Math.random() * s; vy = (Math.random() - .5) * s; }
    return { x: x, y: y, vx: vx, vy: vy, r: (Math.random() * 1.6 + 0.7) * DPR * SZ };
  }

  function computeRing() {
    var el = document.querySelector('.auth-logo-anim');
    if (!el) { ring = null; return; }
    var cr = canvas.getBoundingClientRect(), ar = el.getBoundingClientRect();
    ring = {
      x: (ar.left + ar.width / 2 - cr.left) * DPR,
      y: (ar.top + ar.height / 2 - cr.top) * DPR,
      r: (ar.width / 2) * DPR,
    };
  }

  function resize() {
    var r = canvas.getBoundingClientRect();
    W = canvas.width = Math.max(1, Math.floor(r.width * DPR));
    H = canvas.height = Math.max(1, Math.floor(r.height * DPR));
    // En pantallas chicas (celular) los nodos y la red se reducen
    var small = r.width < 560;
    SZ = small ? 0.6 : 1;
    N = Math.max(small ? 14 : 28, Math.min(110, Math.floor((r.width * r.height) / 13000)));
    MAXD = Math.min(W, (small ? 120 : 170) * DPR);
    nodes = [];
    for (var i = 0; i < N; i++) {
      var n = spawnEdge();
      n.x = Math.random() * W; n.y = Math.random() * H;
      nodes.push(n);
    }
    computeRing();
  }

  function frame() {
    ctx.clearRect(0, 0, W, H);

    // Halo de energía del círculo (más brillante cuanta más energía recibe)
    if (ring && energy > 0.01) {
      var hr = ring.r * (1.15 + energy * 0.3);
      var g = ctx.createRadialGradient(ring.x, ring.y, ring.r * 0.45, ring.x, ring.y, hr);
      g.addColorStop(0, 'rgba(255,221,140,' + Math.min(0.55, 0.12 + energy * 0.42).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ring.x, ring.y, hr, 0, 6.2832); ctx.fill();
    }
    energy *= 0.95;

    // Pulsos (ondas que salen del círculo al recibir un nodo)
    if (ring) {
      for (var pi = pulses.length - 1; pi >= 0; pi--) {
        var pu = pulses[pi];
        pu.r += 2.3 * DPR; pu.a -= 0.018;
        if (pu.a <= 0) { pulses.splice(pi, 1); continue; }
        ctx.strokeStyle = 'rgba(255,214,130,' + pu.a.toFixed(3) + ')';
        ctx.lineWidth = 1.5 * DPR;
        ctx.beginPath(); ctx.arc(ring.x, ring.y, pu.r, 0, 6.2832); ctx.stroke();
      }
    }

    // Mover nodos + interacción con el círculo
    var pull = 0.055 * DPR, maxV = 1.6 * DPR;
    for (var i = 0; i < N; i++) {
      var n = nodes[i];
      if (ring) {
        var dx = ring.x - n.x, dy = ring.y - n.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.001;
        if (d <= ring.r + 2 * DPR) {
          // Toca el círculo → desaparece y lo carga
          energy = Math.min(1.7, energy + 0.4);
          pulses.push({ r: ring.r, a: 0.9 });
          nodes[i] = spawnEdge();
          continue;
        }
        var range = ring.r * 2.0;
        if (d < range) {
          var t = 1 - (d - ring.r) / (range - ring.r);   // 0 lejos … 1 pegado
          n.vx += (dx / d) * pull * t;
          n.vy += (dy / d) * pull * t;
          // Haz de energía del nodo al borde del círculo
          var ex = ring.x - (dx / d) * ring.r, ey = ring.y - (dy / d) * ring.r;
          ctx.strokeStyle = 'rgba(255,210,120,' + (t * 0.6).toFixed(3) + ')';
          ctx.lineWidth = (0.6 + t * 0.9) * DPR;
          ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(ex, ey); ctx.stroke();
        }
      }
      n.x += n.vx; n.y += n.vy;
      var sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > maxV) { n.vx = n.vx / sp * maxV; n.vy = n.vy / sp * maxV; }
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
    }

    // Conexiones entre nodos
    for (var a = 0; a < N; a++) {
      for (var b = a + 1; b < N; b++) {
        var p = nodes[a], q = nodes[b];
        var cx = p.x - q.x, cy = p.y - q.y, cd = Math.sqrt(cx * cx + cy * cy);
        if (cd < MAXD) {
          var o = (1 - cd / MAXD) * 0.5;
          ctx.strokeStyle = 'rgba(238,196,120,' + o.toFixed(3) + ')';
          ctx.lineWidth = 0.6 * DPR;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
    }

    // Nodos con brillo
    for (var k = 0; k < N; k++) {
      var m = nodes[k];
      var gg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 4.5);
      gg.addColorStop(0, 'rgba(255,226,150,0.85)');
      gg.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 4.5, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(255,236,184,0.95)';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.2832); ctx.fill();
    }

    if (!reduce) requestAnimationFrame(frame);
  }

  window.addEventListener('resize', function () { resize(); });
  resize();
  frame();
})();
