/* Animated background: a meadow that grows.
 *
 * Blades sprout from the bottom edge and sway on a slow wind, with a few
 * growing well above the rest and catching the light — the product's thesis
 * as organic growth rather than a starfield.
 *
 * Kept cheap: blade count scales to viewport width, everything is a single
 * quadratic curve, and the loop stops when the tab is hidden or the user
 * prefers reduced motion.
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
  var blades = [];
  var motes = [];
  var mouse = { x: -9999, y: -9999 };
  var running = true;
  var frame = 0;
  var time = 0;

  var MOUSE_RADIUS = 170;

  function bladeCount() {
    // Roughly one blade per 9px of width, bounded so phones stay smooth and
    // ultrawides don't draw hundreds of curves per frame.
    return Math.max(40, Math.min(150, Math.round(width / 9)));
  }

  function makeBlade(index, total) {
    // Outliers are rare and much taller — the one that broke away.
    var isOutlier = index % 11 === 4;
    var baseHeight = height * (isOutlier ? 0.30 : 0.13);

    return {
      x: (index / total) * width + (Math.random() - 0.5) * 14,
      height: baseHeight * (0.65 + Math.random() * 0.7),
      // Thicker blades read as nearer; drawn later so they sit in front.
      depth: isOutlier ? 1 : 0.35 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 0.5,
      lean: (Math.random() - 0.5) * 0.5,
      outlier: isOutlier,
      // Staggered so the meadow grows in rather than appearing at once.
      grown: 0,
      growRate: 0.006 + Math.random() * 0.012
    };
  }

  function makeMote() {
    return {
      x: Math.random() * width,
      y: height + Math.random() * height * 0.5,
      radius: 0.8 + Math.random() * 1.6,
      drift: (Math.random() - 0.5) * 0.18,
      rise: 0.18 + Math.random() * 0.34,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.16 + Math.random() * 0.3
    };
  }

  function build() {
    var count = bladeCount();
    blades = [];
    for (var i = 0; i < count; i++) blades.push(makeBlade(i, count));
    // Near blades drawn last so depth reads correctly.
    blades.sort(function (a, b) { return a.depth - b.depth; });

    motes = [];
    var moteCount = Math.max(10, Math.min(28, Math.round(width / 70)));
    for (var m = 0; m < moteCount; m++) motes.push(makeMote());
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
    time += 0.006;

    for (var i = 0; i < blades.length; i++) {
      var b = blades[i];
      if (b.grown < 1) b.grown = Math.min(1, b.grown + b.growRate);
    }

    for (var m = 0; m < motes.length; m++) {
      var mote = motes[m];
      mote.y -= mote.rise;
      mote.x += mote.drift + Math.sin(time * 2 + mote.phase) * 0.16;
      // Recycle at the bottom rather than accumulating new objects.
      if (mote.y < -12) {
        mote.y = height + 12;
        mote.x = Math.random() * width;
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // One shared wind wave so the meadow moves together instead of each
    // blade wobbling on its own.
    var gust = Math.sin(time * 0.7) * 0.5 + Math.sin(time * 1.9) * 0.18;

    for (var i = 0; i < blades.length; i++) {
      var b = blades[i];
      var h = b.height * b.grown;
      if (h < 1) continue;

      var sway = Math.sin(time * b.speed + b.phase) * 0.24 + gust * 0.5;

      // The cursor parts the grass it passes over.
      var dx = b.x - mouse.x;
      if (mouse.y > height - b.height * 1.6 && dx > -MOUSE_RADIUS && dx < MOUSE_RADIUS) {
        var push = (1 - Math.abs(dx) / MOUSE_RADIUS);
        sway += (dx > 0 ? 1 : -1) * push * 0.9;
      }

      var tipX = b.x + (b.lean + sway) * h * 0.42;
      var tipY = height - h;
      var ctrlX = b.x + (b.lean + sway) * h * 0.16;
      var ctrlY = height - h * 0.55;

      ctx.beginPath();
      ctx.moveTo(b.x, height);
      ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);

      ctx.lineWidth = b.outlier ? 2 : 0.7 + b.depth * 1.1;
      ctx.lineCap = "round";

      if (b.outlier) {
        ctx.strokeStyle = "rgba(110, 231, 183, " + (0.34 * b.grown).toFixed(3) + ")";
        ctx.shadowBlur = 10;
        ctx.shadowColor = "rgba(52, 211, 153, 0.5)";
      } else {
        // Nearer blades slightly brighter, so the field has depth.
        var alpha = (0.07 + b.depth * 0.14) * b.grown;
        ctx.strokeStyle = "rgba(52, 211, 153, " + alpha.toFixed(3) + ")";
        ctx.shadowBlur = 0;
      }
      ctx.stroke();

      // A seed head on the tall ones, catching the light.
      if (b.outlier && b.grown > 0.85) {
        ctx.beginPath();
        ctx.arc(tipX, tipY, 2.1, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(110, 231, 183, " + (0.5 + Math.sin(time * 2 + b.phase) * 0.28).toFixed(3) + ")";
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0;

    // Pollen drifting up through the meadow.
    for (var m = 0; m < motes.length; m++) {
      var mote = motes[m];
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(167, 243, 208, " + mote.alpha.toFixed(3) + ")";
      ctx.fill();
    }
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
