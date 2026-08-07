/* Animated background: a drifting field of data points with a few outliers
 * breaking away from the pack — the product's thesis as ambient motion.
 *
 * Kept deliberately cheap: particle count scales to viewport area, the
 * neighbour search is capped, and the loop stops entirely when the tab is
 * hidden or the user prefers reduced motion.
 */

(function () {
  "use strict";

  var canvas = document.getElementById("field");
  if (!canvas) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    canvas.style.display = "none";
    return;
  }

  var ctx = canvas.getContext("2d", { alpha: true });
  var width = 0, height = 0, dpr = 1;
  var particles = [];
  var mouse = { x: -9999, y: -9999 };
  var running = true;
  var frame = 0;

  var LINK_DISTANCE = 132;     // px at which two points draw a connection
  var LINK_DISTANCE_SQ = LINK_DISTANCE * LINK_DISTANCE;
  var MOUSE_RADIUS = 150;
  var MOUSE_RADIUS_SQ = MOUSE_RADIUS * MOUSE_RADIUS;

  function particleCount() {
    // One point per ~26k css px², clamped so phones stay smooth and huge
    // monitors don't tip the O(n²) link pass into jank.
    return Math.max(26, Math.min(78, Math.round((width * height) / 26000)));
  }

  function makeParticle(isOutlier) {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      radius: isOutlier ? 2.4 + Math.random() * 1.2 : 1 + Math.random() * 1.1,
      outlier: isOutlier,
      phase: Math.random() * Math.PI * 2,   // desynchronises the glow pulse
      drift: isOutlier ? -0.12 - Math.random() * 0.1 : 0   // outliers rise
    };
  }

  function build() {
    var count = particleCount();
    particles = [];
    for (var i = 0; i < count; i++) {
      // Roughly one in nine breaks away — enough to notice, rare enough to read
      // as exceptional rather than decorative.
      particles.push(makeParticle(i % 9 === 0));
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    build();
  }

  function step() {
    var i, p;

    for (i = 0; i < particles.length; i++) {
      p = particles[i];

      p.x += p.vx;
      p.y += p.vy + p.drift;
      p.phase += 0.016;

      // Push away from the cursor so the field reacts to the reader.
      var mdx = p.x - mouse.x;
      var mdy = p.y - mouse.y;
      var mdistSq = mdx * mdx + mdy * mdy;
      if (mdistSq < MOUSE_RADIUS_SQ && mdistSq > 0.01) {
        var mdist = Math.sqrt(mdistSq);
        var push = (1 - mdist / MOUSE_RADIUS) * 0.9;
        p.x += (mdx / mdist) * push;
        p.y += (mdy / mdist) * push;
      }

      // Wrap rather than bounce — bouncing makes the edges legible as walls.
      if (p.x < -20) p.x = width + 20;
      if (p.x > width + 20) p.x = -20;
      if (p.y < -20) { p.y = height + 20; p.x = Math.random() * width; }
      if (p.y > height + 20) p.y = -20;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    var i, j, a, b, dx, dy, distSq;

    // Links first so points sit on top of their own connections.
    ctx.lineWidth = 1;
    for (i = 0; i < particles.length; i++) {
      a = particles[i];
      for (j = i + 1; j < particles.length; j++) {
        b = particles[j];
        dx = a.x - b.x;
        dy = a.y - b.y;
        if (dx > LINK_DISTANCE || dx < -LINK_DISTANCE) continue;   // cheap reject
        if (dy > LINK_DISTANCE || dy < -LINK_DISTANCE) continue;

        distSq = dx * dx + dy * dy;
        if (distSq > LINK_DISTANCE_SQ) continue;

        var strength = 1 - distSq / LINK_DISTANCE_SQ;
        ctx.strokeStyle = "rgba(52, 211, 153, " + (strength * 0.14).toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    for (i = 0; i < particles.length; i++) {
      var p = particles[i];

      if (p.outlier) {
        var pulse = 0.55 + Math.sin(p.phase) * 0.45;
        ctx.shadowBlur = 12 * pulse;
        ctx.shadowColor = "rgba(52, 211, 153, 0.9)";
        ctx.fillStyle = "rgba(110, 231, 183, " + (0.5 + pulse * 0.42).toFixed(3) + ")";
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(125, 170, 148, 0.32)";
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function loop() {
    if (!running) return;
    step();
    draw();
    frame = requestAnimationFrame(loop);
  }

  window.addEventListener("resize", function () {
    clearTimeout(window.__fieldResize);
    window.__fieldResize = setTimeout(resize, 180);
  });

  window.addEventListener("mousemove", function (event) {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
  }, { passive: true });

  window.addEventListener("mouseout", function () {
    mouse.x = -9999;
    mouse.y = -9999;
  });

  // A background animation has no business burning cycles on a hidden tab.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      loop();
    }
  });

  resize();
  loop();
})();
