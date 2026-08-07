/* Outlier — reveal animations, count-ups, and the interactive bits. */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ toast */

  var toastEl = document.getElementById("toast");
  var toastTimer;

  function toast(message, isError) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = "toast";
    }, 2800);
  }

  /* ------------------------------------------------------------ count-up */

  function countUp(el) {
    var target = parseFloat(el.dataset.countup);
    if (isNaN(target)) return;

    // Preserve one decimal only when the source value actually had one.
    var decimals = (el.dataset.countup.indexOf(".") !== -1) ? 1 : 0;

    if (reduceMotion) {
      el.textContent = target.toFixed(decimals);
      return;
    }

    var duration = 900;
    var start = performance.now();

    function frame(now) {
      var progress = Math.min((now - start) / duration, 1);
      // Ease-out cubic so it decelerates into the final number.
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = (target * eased).toFixed(decimals);
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------ reveal */

  var revealed = new WeakSet();

  function activate(el) {
    if (revealed.has(el)) return;
    revealed.add(el);
    el.classList.add("in");

    el.querySelectorAll("[data-countup]").forEach(countUp);
    el.querySelectorAll(".baseline-fill").forEach(function (bar) {
      // Delay so the width transition is visible after the card fades in.
      setTimeout(function () {
        bar.style.width = bar.dataset.fill + "%";
      }, 180);
    });
  }

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, index) {
        if (!entry.isIntersecting) return;
        // Stagger within a batch so a screenful cascades instead of popping.
        setTimeout(function () { activate(entry.target); }, index * 55);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });

    document.querySelectorAll(".reveal").forEach(function (el) {
      observer.observe(el);
    });

    // Failsafe: .reveal starts at opacity 0, so if the observer never fires
    // (background tab, non-compositing viewport, an observer that silently
    // fails) the page would sit permanently blank. Content visibility must
    // never depend on an animation callback — force anything still hidden.
    setTimeout(function () {
      document.querySelectorAll(".reveal:not(.in)").forEach(activate);
    }, 1200);
  } else {
    document.querySelectorAll(".reveal").forEach(activate);
  }

  // Count-ups outside a .reveal wrapper still need running.
  document.querySelectorAll("[data-countup]").forEach(function (el) {
    if (!el.closest(".reveal")) countUp(el);
  });

  /* ------------------------------------------------------------ save */

  document.addEventListener("click", function (event) {
    var btn = event.target.closest(".save-btn");
    if (!btn) return;
    event.preventDefault();

    fetch("/api/save/" + btn.dataset.postId, { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error("save failed");
        btn.classList.toggle("is-saved", data.saved);
        toast(data.saved ? "Saved to library" : "Removed from library");
      })
      .catch(function () { toast("Could not save that post", true); });
  });

  /* ------------------------------------------------------------ copy */

  document.addEventListener("click", function (event) {
    var btn = event.target.closest(".copy-btn");
    if (!btn) return;

    var target = document.getElementById(btn.dataset.copyTarget);
    if (!target) return;

    navigator.clipboard.writeText(target.textContent.trim())
      .then(function () { toast("Copied to clipboard"); })
      .catch(function () { toast("Clipboard blocked by the browser", true); });
  });

  /* ------------------------------------------------------------ demo data */

  function demoRequest(method, label) {
    return function () {
      toast(label + "…");
      fetch("/api/demo", { method: method })
        .then(function (r) { return r.json(); })
        .then(function () { window.location.reload(); })
        .catch(function () { toast("That didn't work", true); });
    };
  }

  var loadDemo = document.getElementById("load-demo");
  if (loadDemo) loadDemo.addEventListener("click", demoRequest("POST", "Loading sample data"));

  var clearDemo = document.getElementById("clear-demo");
  if (clearDemo) clearDemo.addEventListener("click", demoRequest("DELETE", "Clearing sample data"));

  /* ------------------------------------------------------------ remix */

  var remixBtn = document.getElementById("remix-btn");
  if (remixBtn) {
    remixBtn.addEventListener("click", function () {
      var angles = Array.from(
        document.querySelectorAll('input[name="angle"]:checked')
      ).map(function (input) { return input.value; });

      if (!angles.length) {
        toast("Pick at least one angle", true);
        return;
      }

      var status = document.getElementById("remix-status");
      remixBtn.disabled = true;
      remixBtn.textContent = "Generating…";
      status.className = "remix-status";
      status.textContent = "Writing variants — this takes a few seconds.";

      fetch("/api/remix/" + remixBtn.dataset.postId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ angles: angles })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Remix failed");
          renderRemix(data.result);
          status.textContent = "";
          toast("Variants ready");
        })
        .catch(function (error) {
          status.className = "remix-status error";
          status.textContent = error.message;
        })
        .finally(function () {
          remixBtn.disabled = false;
          remixBtn.textContent = "Generate variants";
        });
    });
  }

  function renderRemix(result) {
    var output = document.getElementById("remix-output");
    if (!output) return;

    var wrapper = document.createElement("div");
    wrapper.className = "remix-result";

    var why = document.createElement("p");
    why.className = "why";
    var whyLabel = document.createElement("b");
    whyLabel.textContent = "Why it worked: ";
    why.appendChild(whyLabel);
    // textContent throughout — model output is never injected as HTML.
    why.appendChild(document.createTextNode(result.why_it_worked || ""));
    wrapper.appendChild(why);

    (result.variants || []).forEach(function (variant, index) {
      var id = "fresh-" + Date.now() + "-" + index;

      var block = document.createElement("div");
      block.className = "variant";
      block.style.animationDelay = (index * 90) + "ms";

      var head = document.createElement("div");
      head.className = "variant-head";

      var angle = document.createElement("span");
      angle.className = "variant-angle";
      angle.textContent = (variant.angle || "").replace(/_/g, " ");

      var copy = document.createElement("button");
      copy.className = "copy-btn";
      copy.dataset.copyTarget = id;
      copy.textContent = "Copy";

      head.appendChild(angle);
      head.appendChild(copy);

      var body = document.createElement("p");
      body.className = "variant-body";
      body.id = id;
      body.textContent = variant.body || "";

      block.appendChild(head);
      block.appendChild(body);
      wrapper.appendChild(block);
    });

    output.prepend(wrapper);
  }
})();
