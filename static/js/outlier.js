/* Outlier — reveal animations, count-ups, and the interactive bits. */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ requests */

  // Every state-changing call carries the session's CSRF token. Wrapping fetch
  // here means a new endpoint cannot forget it and fail in production only.
  var CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";

  function post(url, body, method) {
    var options = {
      method: method || "POST",
      headers: { "X-CSRF-Token": CSRF }
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      if (response.status === 401) {
        window.location.href = "/login";
        throw new Error("Signed out");
      }
      // A 500 returns an HTML error page, not JSON. Parsing that throws a
      // useless "Unexpected token <" — surface the status instead so the real
      // failure is legible rather than swallowed by a generic catch.
      return response.json().catch(function () {
        throw new Error("Server error (" + response.status + ")");
      });
    });
  }

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

    // A bigger number takes longer to climb. A 47x and a 1.2x counting at the
    // same speed is the whole reason the feed reads flat — the number that
    // deserves attention should visibly take more work to reach.
    var duration = Math.max(700, Math.min(700 + Math.abs(target) * 17, 1500));
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

    // The badge arc and the scale bar encode the same number, so they run
    // together — the ring sweeping while the bar reaches past the median.
    var RING_CIRCUMFERENCE = 138.2;   // 2 * PI * r, with r = 22 in the SVG
    el.querySelectorAll(".post-badge[data-arc]").forEach(function (badge) {
      var pct = parseFloat(badge.dataset.arc);
      if (isNaN(pct)) return;
      var ring = badge.querySelector(".ring-fill");
      if (!ring) return;
      // Offset shrinks from full circumference to the arc's remainder.
      ring.style.setProperty(
        "--arc",
        (RING_CIRCUMFERENCE * (1 - Math.min(pct, 100) / 100)).toFixed(1)
      );
    });

    // A breakout is the entire point of the product, so it gets a different
    // arrival than a 1.2x post: the bar overruns the median and settles back,
    // and the badge throws off one ring of light as the score lands.
    var isBreakout = el.classList.contains("tier-breakout");

    // Delay so the width transition is visible after the card fades in.
    setTimeout(function () {
      el.querySelectorAll(".scale-fill").forEach(function (bar) {
        bar.style.width = bar.dataset.fill + "%";
      });

      el.querySelectorAll(".scale-over").forEach(function (bar) {
        var target = parseFloat(bar.dataset.over);
        if (isNaN(target)) return;

        if (!isBreakout || reduceMotion) {
          bar.style.width = target + "%";
          return;
        }

        // The bar starts at the median notch (25%), so it can never be wider
        // than the 75% remaining. Clamp the overshoot rather than letting a
        // near-full bar run off the end of its own track.
        var peak = Math.min(target + 3.5, 75);
        bar.style.setProperty("--over-target", target + "%");
        bar.style.setProperty("--over-peak", peak + "%");
        bar.classList.add("surge");
      });
    }, 180);

    if (isBreakout && !reduceMotion) {
      var badge = el.querySelector(".post-badge[data-arc]");
      // Fires as the ring finishes drawing, so the flare reads as the score
      // landing rather than as decoration that happens to be on the page.
      if (badge) setTimeout(function () { badge.classList.add("beat"); }, 1100);
    }
  }

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      var arriving = entries.filter(function (entry) {
        return entry.isIntersecting;
      });

      // IntersectionObserver makes no promise about the order of a batch, so
      // a screenful used to cascade in whatever order the entries happened to
      // arrive in. Sorting by document position is what makes the list read
      // as assembling top-down instead of pieces lighting up at random.
      arriving.sort(function (a, b) {
        var relation = a.target.compareDocumentPosition(b.target);
        return (relation & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      });

      arriving.forEach(function (entry, index) {
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

  /* --------------------------------------------------- view transition */

  // The card you click becomes the page it opens. Cross-document view
  // transitions do the work; all this does is tell the browser which badge
  // on a feed full of them is the one being carried across. Purely additive:
  // where the API is missing the link just navigates, as it always did.
  if (!reduceMotion && window.CSS && CSS.supports &&
      CSS.supports("view-transition-name", "none")) {
    document.addEventListener("click", function (event) {
      var link = event.target.closest('a[href*="/post/"]');
      if (!link) return;

      var card = link.closest(".post-card");
      if (!card) return;
      var badge = card.querySelector(".post-badge");
      if (!badge) return;

      // A name has to be unique across the document while the transition
      // runs, so any badge named by an earlier click is released first.
      document.querySelectorAll("[data-vt-named]").forEach(function (prior) {
        prior.style.viewTransitionName = "";
        prior.removeAttribute("data-vt-named");
      });

      badge.style.viewTransitionName = "post-hero";
      badge.setAttribute("data-vt-named", "");
    });
  }

  /* ------------------------------------------------------------ hover FX */

  // Cursor-tracking spotlight. One delegated
  // listener, coalesced into a single rAF per frame — 60 cards each with their
  // own mousemove handler would drop frames on scroll.
  if (!reduceMotion) {
    var fxTarget = null, fxX = 0, fxY = 0, fxQueued = false;

    function applyFx() {
      fxQueued = false;
      if (!fxTarget) return;

      var rect = fxTarget.getBoundingClientRect();
      var relX = fxX - rect.left;
      var relY = fxY - rect.top;

      // Spotlight position, consumed by a radial-gradient in CSS.
      fxTarget.style.setProperty("--mx", relX + "px");
      fxTarget.style.setProperty("--my", relY + "px");

    }

    document.addEventListener("mousemove", function (event) {
      var target = event.target.closest(".spotlight");

      if (target !== fxTarget) {
        if (fxTarget) fxTarget.classList.remove("fx-on");
        fxTarget = target;
        if (fxTarget) fxTarget.classList.add("fx-on");
      }

      if (!fxTarget) return;
      fxX = event.clientX;
      fxY = event.clientY;
      if (!fxQueued) {
        fxQueued = true;
        requestAnimationFrame(applyFx);
      }
    }, { passive: true });

    // Magnetic buttons: nudge toward the cursor when it's close.
    document.addEventListener("mousemove", function (event) {
      var btn = event.target.closest(".btn-primary");
      if (!btn) {
        document.querySelectorAll(".btn-primary[style*='translate']").forEach(function (b) {
          b.style.transform = "";
        });
        return;
      }
      var rect = btn.getBoundingClientRect();
      var dx = event.clientX - (rect.left + rect.width / 2);
      var dy = event.clientY - (rect.top + rect.height / 2);
      btn.style.transform = "translate(" + (dx * 0.14).toFixed(1) + "px," +
                            (dy * 0.2).toFixed(1) + "px)";
    }, { passive: true });

    document.addEventListener("mouseleave", function (event) {
      var btn = event.target.closest && event.target.closest(".btn-primary");
      if (btn) btn.style.transform = "";
    }, true);
  }

  // A reset navigates away, so its confirmation has to survive the load.
  var resetNote = window.sessionStorage.getItem("outlier-reset");
  if (resetNote) {
    window.sessionStorage.removeItem("outlier-reset");
    setTimeout(function () { toast(resetNote); }, 240);
  }

  /* ------------------------------------------------------------ sources */

  document.addEventListener("click", function (event) {
    var renameBtn = event.target.closest(".rename-source");
    if (renameBtn) {
      var id = renameBtn.dataset.sourceId;
      var label = document.querySelector('.src-name[data-source-id="' + id + '"]');
      var current = label ? label.textContent.trim() : "";
      var next = window.prompt("Rename this source:", current);
      if (next === null) return;
      next = next.trim();
      if (!next) { toast("Name cannot be empty", true); return; }

      post("/api/source/" + id, { name: next }, "PATCH")
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Rename failed");
          if (label) label.textContent = data.name;
          toast("Renamed");
        })
        .catch(function (error) { toast(error.message, true); });
      return;
    }

    var deleteBtn = event.target.closest(".delete-source");
    if (deleteBtn) {
      var sourceId = deleteBtn.dataset.sourceId;
      var name = deleteBtn.dataset.sourceName || "this source";
      if (!window.confirm('Delete "' + name + '" and every post captured from it?\n\nThis cannot be undone.')) return;

      post("/api/source/" + sourceId, undefined, "DELETE")
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Delete failed");
          // The grid renders each source as a card, not a table row, so remove
          // the whole card — closest("tr") always missed and left it on screen.
          var card = deleteBtn.closest(".source-card") || deleteBtn.closest("tr");
          if (card) {
            card.style.transition = "opacity 0.25s, transform 0.25s";
            card.style.opacity = "0";
            card.style.transform = "translateX(-14px)";
            setTimeout(function () { card.remove(); }, 260);
          }
          toast("Deleted " + data.deleted + " posts");
        })
        .catch(function (err) {
          var msg = (err && err.message) || "Could not delete that source";
          // A stale page carries an old CSRF token; the cure is a reload, so
          // say that instead of a dead-end error.
          if (/csrf|token/i.test(msg)) {
            msg = "Your session refreshed in another tab — reload this page and try again.";
          }
          toast(msg, true);
        });
    }
  });

  /* ----------------------------------------------------- source kind */

  // Profile vs Page can't always be told apart automatically, so the label is
  // editable on the source card. The choice is saved straight away and sticks —
  // a later scan won't overwrite it (see upsert_source).
  document.addEventListener("change", function (event) {
    var select = event.target.closest(".kind-select");
    if (!select) return;
    var id = select.dataset.sourceId;
    select.disabled = true;
    post("/api/source/" + id, { kind: select.value }, "PATCH")
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "Could not update");
        toast("Marked as " + select.value);
      })
      .catch(function (err) {
        toast((err && err.message) || "Could not update the type", true);
      })
      .then(function () { select.disabled = false; });
  });

  /* ------------------------------------------------------------ save */

  document.addEventListener("click", function (event) {
    var btn = event.target.closest(".save-btn");
    if (!btn) return;
    event.preventDefault();

    post("/api/save/" + btn.dataset.postId)
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
      post("/api/demo", undefined, method)
        .then(function () { window.location.reload(); })
        .catch(function () { toast("That didn't work", true); });
    };
  }

  var loadDemo = document.getElementById("load-demo");
  if (loadDemo) loadDemo.addEventListener("click", demoRequest("POST", "Loading sample data"));

  var clearDemo = document.getElementById("clear-demo");
  if (clearDemo) clearDemo.addEventListener("click", demoRequest("DELETE", "Clearing sample data"));

  /* ------------------------------------------------------------ graphics */

  /* One handler for every "Generate graphic" button on the page.
   *
   * This used to be built per variant, in a closure, at the moment JavaScript
   * rendered a fresh remix — so a variant loaded from the database had no
   * button at all, and leaving the page and coming back lost the option. Both
   * paths now render the same markup with the hook and body as data
   * attributes, and this reads them off whichever button was pressed.
   */
  document.addEventListener("click", function (event) {
    if (!event.target.closest) return;
    var button = event.target.closest(".graphic-btn");
    if (!button) return;

    var block = button.closest(".variant");
    if (!block) return;

    // Built on first press and kept afterwards, so a regenerate is a tweak of
    // what was typed rather than a retype.
    var direction = block.querySelector(".graphic-direction");
    if (!direction) {
      direction = document.createElement("div");
      direction.className = "graphic-direction";

      var brief = document.createElement("textarea");
      brief.className = "graphic-brief";
      brief.rows = 2;
      brief.placeholder =
        "Optional: describe the image you want — subject, style, colours, " +
        "mood. Say \"with the text …\" if you want words on it.";

      var go = document.createElement("button");
      go.type = "button";
      go.className = "btn btn-ghost graphic-go";
      go.textContent = "Generate";

      direction.appendChild(brief);
      direction.appendChild(go);
      block.appendChild(direction);

      go.addEventListener("click", function () { runGraphic(button, block); });
      brief.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runGraphic(button, block);
      });
      brief.focus();
      return;                       // first press opens the brief, spends nothing
    }
    runGraphic(button, block);
  });

  function runGraphic(button, block) {
    var brief = block.querySelector(".graphic-brief");
    var go = block.querySelector(".graphic-go");
    var label = button.textContent;
    button.disabled = true;
    if (go) go.disabled = true;
    button.textContent = "Generating…";

    // The space the picture will occupy, claimed immediately and shimmering
    // while it is empty. A button label is too small and too far from where
    // the eye is to read as anything happening.
    var old = block.querySelector(".variant-graphic");
    if (old) old.remove();

    var wrap = document.createElement("div");
    wrap.className = "variant-graphic is-loading";
    var skeleton = document.createElement("div");
    skeleton.className = "graphic-skeleton";
    var note = document.createElement("div");
    note.className = "graphic-progress";
    note.textContent = "Painting your graphic…";
    wrap.appendChild(skeleton);
    wrap.appendChild(note);
    block.appendChild(wrap);

    var started = Date.now();
    var ticker = window.setInterval(function () {
      var seconds = Math.round((Date.now() - started) / 1000);
      note.textContent = "Painting your graphic… " + seconds + "s" +
        (seconds >= 30 ? " — larger images can take a minute" : "");
    }, 1000);
    function stop() { window.clearInterval(ticker); }

    post("/api/graphic", {
      hook: button.dataset.hook || "",
      // The body as well as the hook. A hook is a fragment written to intrigue
      // and describes no scene, which is why the pictures had nothing to do
      // with the post they illustrated.
      body: button.dataset.body || "",
      instructions: brief ? brief.value.trim() : ""
    })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "Could not generate a graphic");
        stop();
        var img = document.createElement("img");
        img.alt = "Generated graphic";
        var dl = document.createElement("a");
        dl.href = data.image;
        dl.download = "tallgrass-graphic.png";
        dl.className = "graphic-dl";
        dl.textContent = "Download";

        // Held until the bytes decode. Swapping on the response alone leaves a
        // blank frame where the shimmer was.
        img.addEventListener("load", function () {
          wrap.className = "variant-graphic";
          wrap.textContent = "";
          wrap.appendChild(img);
          wrap.appendChild(dl);
        });
        img.addEventListener("error", function () {
          wrap.remove();
          toast("The image could not be displayed", true);
        });
        img.src = data.image;
        button.textContent = "Regenerate graphic";
      })
      .catch(function (error) {
        stop();
        wrap.remove();
        toast(error.message, true);
        button.textContent = label;
      })
      .finally(function () {
        stop();
        button.disabled = false;
        if (go) go.disabled = false;
      });
  }

  /* ------------------------------------------------------ delete a post */

  // Delegated from the document, because post cards appear on the feed, on a
  // group page and in the library, and every one of them carries this button.
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest(".delete-post");
    if (!button) return;

    var card = button.closest("[data-post-id]");
    if (!window.confirm("Delete this post?\n\nIt is removed from your dashboard " +
                        "and stops counting toward the group's baseline. " +
                        "Re-scanning the group will capture it again.")) return;

    button.disabled = true;
    post("/api/post/" + button.dataset.postId, undefined, "DELETE")
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "Could not delete that post");
        // Faded out rather than removed outright, so the row does not vanish
        // from under the cursor with no sign of what happened.
        if (card) {
          card.style.transition = "opacity 0.25s var(--ease), transform 0.25s var(--ease)";
          card.style.opacity = "0";
          card.style.transform = "scale(0.98)";
          window.setTimeout(function () { card.remove(); }, 260);
        }
        toast("Post deleted.");
      })
      .catch(function (error) {
        toast(error.message, true);
        button.disabled = false;
      });
  });

  /* --------------------------------------------------------- feedback */

  var fbSubmit = document.getElementById("fb-submit");
  if (fbSubmit) {
    fbSubmit.addEventListener("click", function () {
      var title = document.getElementById("fb-title");
      var body = document.getElementById("fb-body");
      var kindEl = document.querySelector('input[name="fb-kind"]:checked');
      if (!title.value.trim()) {
        toast("Give it a one-line summary first.", true);
        title.focus();
        return;
      }
      fbSubmit.disabled = true;
      post("/api/feedback", {
        kind: kindEl ? kindEl.value : "idea",
        title: title.value.trim(),
        body: body.value.trim()
      })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Could not send that");
          // Reloaded rather than prepended: the board is sorted, and guessing
          // where a new row belongs is how a list starts lying about its order.
          window.sessionStorage.setItem("outlier-reset", "Thanks — that's been sent.");
          window.location.href = "/feedback?sort=new";
        })
        .catch(function (error) {
          toast(error.message, true);
          fbSubmit.disabled = false;
        });
    });
  }

  // One delegated listener for the whole board, so rows cost nothing to add.
  var fbList = document.querySelector(".fb-list");
  if (fbList) {
    fbList.addEventListener("click", function (event) {
      var vote = event.target.closest(".fb-vote");
      if (vote) {
        vote.disabled = true;
        post("/api/feedback/" + vote.dataset.id + "/vote", {})
          .then(function (data) {
            if (!data.ok) return;
            vote.classList.toggle("is-voted", !!data.voted);
            vote.querySelector(".fb-vote-n").textContent = data.votes;
          })
          .catch(function () { toast("Could not register that vote", true); })
          .finally(function () { vote.disabled = false; });
        return;
      }

      var set = event.target.closest(".fb-set");
      if (set) {
        var note = null;
        // Only asked for on the outcomes where silence would be rude.
        if (set.dataset.status === "declined" || set.dataset.status === "shipped") {
          note = window.prompt(
            "Optional note to everyone who voted for this:", "");
          if (note === null) return;
        }
        set.disabled = true;
        post("/api/feedback/" + set.dataset.id + "/status",
             { status: set.dataset.status, note: note || undefined })
          .then(function (data) {
            if (!data.ok) throw new Error(data.error || "Could not update");
            toast("Marked " + data.status + " — " + data.notified +
                  " notified.");
            window.location.reload();
          })
          .catch(function (error) {
            toast(error.message, true);
            set.disabled = false;
          });
      }
    });
  }

  /* ----------------------------------------------------- notifications */

  var notif = document.getElementById("notif");
  if (notif) {
    var bell = document.getElementById("notif-bell");
    var dot = document.getElementById("notif-dot");
    var panel = document.getElementById("notif-panel");
    var list = document.getElementById("notif-list");
    var clearBtn = document.getElementById("notif-clear");
    var loaded = false;

    function renderNotifications(data) {
      list.textContent = "";
      var items = (data && data.items) || [];
      if (!items.length) {
        var empty = document.createElement("p");
        empty.className = "notif-empty";
        empty.textContent = "Nothing yet.";
        list.appendChild(empty);
        return;
      }
      items.forEach(function (item) {
        // A link when there is somewhere to go, a plain block when there is
        // not — an anchor to nowhere is a promise the panel cannot keep.
        var row = document.createElement(item.url ? "a" : "div");
        row.className = "notif-item" + (item.read_at ? "" : " is-unread");
        if (item.url) row.href = item.url;

        var title = document.createElement("span");
        title.className = "notif-title";
        title.textContent = item.title || "";
        row.appendChild(title);

        if (item.body) {
          var body = document.createElement("span");
          body.className = "notif-body";
          body.textContent = item.body;
          row.appendChild(body);
        }
        var when = document.createElement("span");
        when.className = "notif-when";
        when.textContent = (item.created_at || "").slice(0, 16);
        row.appendChild(when);

        list.appendChild(row);
      });
    }

    function setUnread(n) {
      dot.hidden = !n;
      dot.textContent = n > 9 ? "9+" : String(n || "");
    }

    function loadNotifications() {
      return fetch("/api/notifications", { headers: { "X-CSRF-Token": CSRF } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) return;
          setUnread(data.unread);
          renderNotifications(data);
          loaded = true;
        })
        .catch(function () { /* a badge is not worth an error */ });
    }

    bell.addEventListener("click", function (event) {
      event.stopPropagation();
      var opening = panel.hidden;
      panel.hidden = !opening;
      if (!opening) return;

      if (!loaded) loadNotifications();
      // Opening the panel is reading them. The badge clears on open rather
      // than making anyone hunt for a button to say they have looked. The
      // rows keep their own unread styling for this view, so what is new is
      // still visible after the count goes.
      if (!dot.hidden) {
        post("/api/notifications/read", {})
          .then(function (data) { setUnread(data && data.unread); })
          .catch(function () {});
      }
    });

    clearBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      post("/api/notifications/read", {})
        .then(function () { return loadNotifications(); })
        .catch(function () {});
    });

    document.addEventListener("click", function (event) {
      if (!panel.hidden && !notif.contains(event.target)) panel.hidden = true;
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") panel.hidden = true;
    });

    // The badge only. The list itself waits until the panel is opened.
    fetch("/api/notifications", { headers: { "X-CSRF-Token": CSRF } })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data && data.ok) setUnread(data.unread); })
      .catch(function () {});
  }

  var saveUsername = document.getElementById("save-username");
  if (saveUsername) {
    var usernameField = document.getElementById("username-field");
    function saveName() {
      var value = usernameField.value.trim();
      if (!value) { usernameField.focus(); return; }
      saveUsername.disabled = true;
      post("/api/username", { username: value })
        .then(function (data) {
          // The server owns the rules — taken, reserved, wrong shape — so the
          // message shown is the server's, not a guess made here.
          if (!data.ok) throw new Error(data.error || "Could not set that name");
          toast("You're " + data.username + " now.");
        })
        .catch(function (error) {
          toast(error.message, true);
          usernameField.focus();
        })
        .finally(function () { saveUsername.disabled = false; });
    }
    saveUsername.addEventListener("click", saveName);
    usernameField.addEventListener("keydown", function (event) {
      if (event.key === "Enter") saveName();
    });
  }

  var saveViewerName = document.getElementById("save-viewer-name");
  if (saveViewerName) {
    saveViewerName.addEventListener("click", function () {
      var field = document.getElementById("viewer-name");
      var value = field ? field.value.trim() : "";
      saveViewerName.disabled = true;
      post("/api/viewer-name", { names: value })
        .then(function (data) {
          if (!data.ok) throw new Error("Could not save");
          toast(value
            ? "Saved. Your name will not be stored as a caption again."
            : "Cleared — no name is being filtered.");
        })
        .catch(function () { toast("Could not save that name", true); })
        .finally(function () { saveViewerName.disabled = false; });
    });
  }


  var resetAll = document.getElementById("reset-all");
  if (resetAll) {
    resetAll.addEventListener("click", function () {
      // Destructive and unrecoverable — confirm before firing.
      if (!window.confirm("Delete every captured post, group, and saved item?\n\nThis cannot be undone.")) return;
      toast("Deleting everything…");
      post("/api/reset")
        .then(function (data) {
          // Say what actually went, so a reset that quietly did nothing is
          // distinguishable from one that worked.
          var posts = (data && data.posts) || 0;
          var groups = (data && data.sources) || 0;
          window.sessionStorage.setItem("outlier-reset",
            "Deleted " + posts + " post" + (posts === 1 ? "" : "s") +
            " across " + groups + " group" + (groups === 1 ? "" : "s") + ".");
          window.location.href = "/";
        })
        .catch(function () { toast("Reset failed", true); });
    });
  }

  /* ------------------------------------------------------------ install */

  var openFolder = document.getElementById("open-folder");
  if (openFolder) {
    var folderMsg = document.getElementById("open-folder-msg");

    openFolder.addEventListener("click", function () {
      folderMsg.className = "istep-msg";
      folderMsg.textContent = "Opening…";

      post("/api/open-folder")
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Could not open the folder");
          folderMsg.className = "istep-msg ok";
          folderMsg.textContent = "Opened. Look for a window showing the 'extension' folder.";
        })
        .catch(function (error) {
          // Falling back to the copyable path keeps the step doable.
          folderMsg.className = "istep-msg error";
          folderMsg.textContent = error.message + " — copy the path below instead.";
        });
    });
  }

  /* ------------------------------------------------------------ ideas */

  var genIdeas = document.getElementById("gen-ideas");
  if (genIdeas) {
    var ideasStatus = document.getElementById("ideas-status");
    var ideasOutput = document.getElementById("ideas-output");

    document.querySelectorAll(".group-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        document.querySelectorAll(".group-chip").forEach(function (c) {
          c.classList.remove("selected");
        });
        chip.classList.add("selected");
        genIdeas.dataset.sourceId = chip.dataset.sourceId;
        genIdeas.disabled = false;
        genIdeas.textContent = "Write ideas for " + chip.dataset.sourceName;
      });
    });

    genIdeas.addEventListener("click", function () {
      var id = genIdeas.dataset.sourceId;
      if (!id) return;

      genIdeas.disabled = true;
      var label = genIdeas.textContent;
      genIdeas.textContent = "Writing…";
      ideasStatus.className = "msg-line";
      ideasStatus.textContent = "Reading the group's outliers and drafting posts.";

      post("/api/ideas/" + id)
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Could not generate ideas");
          renderIdeas(data.result);
          ideasStatus.textContent = "";
        })
        .catch(function (error) {
          ideasStatus.className = "msg-line error";
          ideasStatus.textContent = error.message;
        })
        .finally(function () {
          genIdeas.disabled = false;
          genIdeas.textContent = label;
        });
    });

    function renderIdeas(result) {
      ideasOutput.textContent = "";

      var panel = document.createElement("div");
      panel.className = "glass panel reveal in";

      var head = document.createElement("h2");
      head.textContent = "What's working here";
      panel.appendChild(head);

      var read = document.createElement("p");
      read.className = "why";
      // textContent throughout — model output is never injected as markup.
      read.textContent = result.read || "";
      panel.appendChild(read);

      (result.ideas || []).forEach(function (idea, index) {
        var id = "idea-" + index;

        var block = document.createElement("div");
        block.className = "variant";
        block.style.animationDelay = (index * 90) + "ms";

        var top = document.createElement("div");
        top.className = "variant-head";

        var fmt = document.createElement("span");
        fmt.className = "variant-angle";
        fmt.textContent = idea.format || "text";

        var copy = document.createElement("button");
        copy.className = "copy-btn";
        copy.dataset.copyTarget = id;
        copy.textContent = "Copy post";

        top.appendChild(fmt);
        top.appendChild(copy);

        var hook = document.createElement("div");
        hook.className = "idea-hook";
        hook.textContent = idea.hook || "";

        var body = document.createElement("p");
        body.className = "variant-body";
        body.id = id;
        body.textContent = idea.body || "";

        var why = document.createElement("p");
        why.className = "idea-why";
        why.textContent = idea.why || "";

        block.appendChild(top);
        block.appendChild(hook);
        block.appendChild(body);
        block.appendChild(why);
        panel.appendChild(block);
      });

      ideasOutput.appendChild(panel);
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ------------------------------------------------------------ Sage */

  var chatForm = document.getElementById("chat-form");
  if (chatForm) {
    var chat = document.getElementById("chat");
    var chatInput = document.getElementById("chat-input");
    var chatSend = document.getElementById("chat-send");
    var chatStatus = document.getElementById("chat-status");
    var suggested = document.getElementById("suggested");

    function addMessage(role, text) {
      var empty = document.getElementById("chat-empty");
      if (empty) empty.remove();

      var wrap = document.createElement("div");
      wrap.className = "msg msg-" + role;

      if (role === "assistant") {
        var who = document.createElement("span");
        who.className = "msg-who";
        who.textContent = "Sage";
        wrap.appendChild(who);
      }

      var body = document.createElement("div");
      body.className = "msg-body";
      // textContent — model output is never trusted as markup.
      body.textContent = text;
      wrap.appendChild(body);

      chat.appendChild(wrap);
      chat.scrollTop = chat.scrollHeight;
      return wrap;
    }

    function thinkingBubble() {
      var wrap = document.createElement("div");
      wrap.className = "msg msg-assistant";
      var dots = document.createElement("div");
      dots.className = "thinking";
      dots.innerHTML = "<span></span><span></span><span></span>";
      wrap.appendChild(dots);
      chat.appendChild(wrap);
      chat.scrollTop = chat.scrollHeight;
      return wrap;
    }

    var chatStop = document.getElementById("chat-stop");
    var sageAbort = null;

    function setAsking(asking) {
      chatInput.disabled = asking;
      chatSend.disabled = asking;
      if (chatStop) chatStop.hidden = !asking;
    }

    // Server-sent events arrive in whatever sized pieces the network hands
    // over, so frames are reassembled here rather than assumed to be whole.
    function readEvents(reader, onEvent) {
      var decoder = new TextDecoder();
      var buffer = "";

      function handle(frame) {
        var line = frame.trim();
        if (line.indexOf("data:") !== 0) return;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch (error) {
          /* A frame we can't parse is skipped rather than killing the stream. */
        }
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          var frames = buffer.split("\n\n");
          // The last piece may be half a frame — hold it for the next read.
          buffer = frames.pop();
          frames.forEach(handle);
          return pump();
        });
      }

      return pump();
    }

    function askSage(question) {
      if (!question) return;

      addMessage("user", question);
      chatInput.value = "";
      setAsking(true);
      if (suggested) suggested.style.display = "none";
      chatStatus.className = "chat-status";
      chatStatus.textContent = "";

      var pending = thinkingBubble();
      var body = null;
      var failure = null;

      // The dots stay until the first real word, then the bubble becomes the
      // answer and fills in place.
      function ensureBody() {
        if (body) return;
        pending.innerHTML = "";
        var who = document.createElement("span");
        who.className = "msg-who";
        who.textContent = "Sage";
        pending.appendChild(who);
        body = document.createElement("div");
        body.className = "msg-body is-streaming";
        pending.appendChild(body);
      }

      sageAbort = new AbortController();

      fetch("/api/sage/stream", {
        method: "POST",
        headers: { "X-CSRF-Token": CSRF, "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
        signal: sageAbort.signal
      })
        .then(function (response) {
          if (response.status === 401) {
            window.location.href = "/login";
            throw new Error("Signed out");
          }
          if (!response.ok || !response.body) {
            throw new Error("Server error (" + response.status + ")");
          }
          return readEvents(response.body.getReader(), function (event) {
            if (event.type === "delta") {
              ensureBody();
              // textContent — model output is never trusted as markup.
              body.textContent += event.text;
              chat.scrollTop = chat.scrollHeight;
            } else if (event.type === "error") {
              failure = event.error;
            }
          });
        })
        .then(function () {
          if (failure) throw new Error(failure);
          if (!body) throw new Error("Sage returned an empty response");
        })
        .catch(function (error) {
          // A cancel is the user getting what they asked for, not a failure.
          // Whatever already arrived stays on screen and stays in the history.
          if (error.name === "AbortError") {
            chatStatus.className = "chat-status";
            chatStatus.textContent = "Stopped.";
            return;
          }
          if (!body) pending.remove();
          chatStatus.className = "chat-status error";
          chatStatus.textContent = error.message;
        })
        .finally(function () {
          if (body) body.classList.remove("is-streaming");
          sageAbort = null;
          setAsking(false);
          chatInput.focus();
        });
    }

    if (chatStop) {
      chatStop.addEventListener("click", function () {
        if (sageAbort) sageAbort.abort();
      });
    }

    chatForm.addEventListener("submit", function (event) {
      event.preventDefault();
      askSage(chatInput.value.trim());
    });

    if (suggested) {
      suggested.addEventListener("click", function (event) {
        var chip = event.target.closest(".chip-btn");
        if (chip) askSage(chip.dataset.prompt);
      });
    }

    var clearChat = document.getElementById("clear-chat");
    if (clearChat) {
      clearChat.addEventListener("click", function () {
        if (!window.confirm("Clear this conversation?")) return;
        post("/api/sage/clear").then(function () { window.location.reload(); });
      });
    }
  }

  /* ------------------------------------------------------------ AI config */

  var saveAi = document.getElementById("save-ai");
  if (saveAi) {
    var aiMsg = document.getElementById("ai-msg");

    document.querySelectorAll('input[name="provider"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        document.querySelectorAll(".provider").forEach(function (label) {
          label.classList.toggle("selected", label.contains(radio) && radio.checked);
        });
        // Swap the model placeholder to the chosen provider's default.
        var model = document.getElementById("ai-model");
        if (model) {
          model.value = radio.value === "anthropic" ? "claude-opus-5" : "gpt-4o";
        }
      });
    });

    saveAi.addEventListener("click", function () {
      var provider = document.querySelector('input[name="provider"]:checked');
      var key = document.getElementById("ai-key").value.trim();
      var model = document.getElementById("ai-model").value.trim();

      if (!provider) {
        aiMsg.className = "msg-line error";
        aiMsg.textContent = "Pick a provider.";
        return;
      }

      aiMsg.className = "msg-line";
      aiMsg.textContent = "Saving…";

      post("/api/sage/config", { provider: provider.value, key: key, model: model })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Save failed");
          aiMsg.className = "msg-line ok";
          aiMsg.textContent = data.has_key
            ? "Saved. Sage is ready — open the Sage tab."
            : "Provider saved, but no key is set yet.";
          document.getElementById("ai-key").value = "";
        })
        .catch(function (error) {
          aiMsg.className = "msg-line error";
          aiMsg.textContent = error.message;
        });
    });
  }

  /* --------------------------------------------------------- brand profile */

  var saveBrand = document.getElementById("save-brand");
  if (saveBrand) {
    var brandMsg = document.getElementById("brand-msg");
    saveBrand.addEventListener("click", function () {
      function val(id) {
        var el = document.getElementById(id);
        return el ? el.value.trim() : "";
      }
      var payload = {
        name: val("brand-name"), offer: val("brand-offer"),
        audience: val("brand-audience"), voice: val("brand-voice"),
        visual: val("brand-visual"), colors: val("brand-colors"),
      };
      brandMsg.className = "msg-line";
      brandMsg.textContent = "Saving…";
      post("/api/brand", payload)
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Save failed");
          brandMsg.className = "msg-line ok";
          brandMsg.textContent = "Saved. Sage and your graphics will use this now.";
        })
        .catch(function (error) {
          brandMsg.className = "msg-line error";
          brandMsg.textContent = error.message;
        });
    });
  }


  /* ------------------------------------------------------------ account */

  /* ------------------------------------------------ connect the extension */

  // Typing a dashboard URL and pasting a key is friction that solves nothing:
  // this page knows both. A content script running on this origin takes them
  // directly, so there is nothing to type and — when the extension isn't
  // already wired here — nothing to click either.
  //
  // This runs on every dashboard page, not just Capture and Account. Landing
  // anywhere while signed in is enough to connect; the visible copy below is
  // just reporting, and is skipped on pages that have no connect block.
  {
    var connectBtn = document.getElementById("connect-btn");
    var connectCopy = document.getElementById("connect-copy");
    var connectMsg = document.getElementById("connect-msg");
    var extensionSeen = false;

    function say(el, text, cls) {
      if (!el) return;
      el.textContent = text;
      if (cls !== undefined) el.className = cls;
    }

    function issueKey(silent) {
      if (connectBtn) connectBtn.disabled = true;
      say(connectMsg, silent ? "Connecting…" : "Issuing a key…", "msg-line");

      return post("/api/account/connect")
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Could not issue a key");
          // Handed to the content script, which writes it into extension
          // storage. The key never touches the address bar or the clipboard.
          window.dispatchEvent(new CustomEvent("outlier:connect", {
            detail: { apiKey: data.api_key }
          }));
        })
        .catch(function (error) {
          if (connectBtn) connectBtn.disabled = false;
          say(connectMsg, error.message, "msg-line error");
        });
    }

    window.addEventListener("outlier:extension-present", function (event) {
      extensionSeen = true;
      var detail = event.detail || {};
      var version = detail.version ? " (v" + detail.version + ")" : "";
      if (connectBtn) {
        connectBtn.style.display = "";
        connectBtn.textContent = "Reconnect";
      }

      if (detail.connected) {
        say(connectCopy, "Extension connected" + version +
                         ". Captures come straight here.");
        return;
      }

      // Nothing to click. The page is signed in and knows its own address, so
      // asking the user to confirm that adds a step and no information. A key
      // is only minted when the extension is unconnected or pointed somewhere
      // else, so this cannot rotate the key on every page load.
      say(connectCopy, "Extension detected" + version + ". Connecting it now…");
      issueKey(true);
    });

    // The content script announces on load; ask again in case this page was
    // ready first.
    window.dispatchEvent(new CustomEvent("outlier:ping-extension"));

    setTimeout(function () {
      if (extensionSeen) return;
      say(connectCopy,
        "No extension detected on this page. Install it from the Capture page, " +
        "then reload here — or connect manually below.");
    }, 1200);

    window.addEventListener("outlier:connect-result", function (event) {
      var detail = event.detail || {};
      if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.textContent = "Reconnect";
      }
      if (detail.ok) {
        say(connectMsg,
          "Connected. The extension will send captures to " + detail.endpoint +
          " — reload any open Facebook tabs.", "msg-line ok");
      } else {
        say(connectMsg, detail.error || "The extension didn't accept it.",
            "msg-line error");
      }
    });

    // The connect block runs on EVERY page so the extension can be handed a
    // key wherever the user happens to be, but the button itself only exists
    // on Capture and Account. Calling addEventListener on null threw, and
    // because this file is one IIFE, that killed every handler defined after
    // it — the pricing page's plan toggle and its checkout button among them.
    if (connectBtn) {
      connectBtn.addEventListener("click", function () { issueKey(false); });
    }
  }

  var rotateKey = document.getElementById("rotate-key");
  if (rotateKey) {
    var rotateMsg = document.getElementById("rotate-msg");
    rotateKey.addEventListener("click", function () {
      var warning = [
        "Generate a new key?",
        "",
        "The current one stops working immediately, and any extension using",
        "it must be updated."
      ].join("\n");
      if (!window.confirm(warning)) return;

      rotateMsg.className = "msg-line";
      rotateMsg.textContent = "Generating…";

      post("/api/account/rotate-key")
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Could not rotate the key");
          document.getElementById("new-key").textContent = data.api_key;
          document.getElementById("new-key-row").style.display = "flex";
          rotateMsg.className = "msg-line ok";
          rotateMsg.textContent = "New key ready — copy it into the extension now.";
        })
        .catch(function (error) {
          rotateMsg.className = "msg-line error";
          rotateMsg.textContent = error.message;
        });
    });
  }

  var savePassword = document.getElementById("save-password");
  if (savePassword) {
    var pwMsg = document.getElementById("pw-msg");
    savePassword.addEventListener("click", function () {
      var current = document.getElementById("pw-current").value;
      var next = document.getElementById("pw-new").value;
      if (!current || !next) {
        pwMsg.className = "msg-line error";
        pwMsg.textContent = "Fill in both fields.";
        return;
      }

      pwMsg.className = "msg-line";
      pwMsg.textContent = "Updating…";

      post("/api/account/password", { current: current, new: next })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Could not update");
          pwMsg.className = "msg-line ok";
          pwMsg.textContent = "Password updated.";
          document.getElementById("pw-current").value = "";
          document.getElementById("pw-new").value = "";
        })
        .catch(function (error) {
          pwMsg.className = "msg-line error";
          pwMsg.textContent = error.message;
        });
    });
  }

  /* ------------------------------------------------------------ pricing */

  var intervalTabs = document.querySelectorAll(".interval-tab");
  if (intervalTabs.length) {
    intervalTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var interval = tab.dataset.interval;
        intervalTabs.forEach(function (t2) { t2.classList.remove("active"); });
        tab.classList.add("active");
        document.querySelectorAll(".price-option").forEach(function (option) {
          option.style.display = option.dataset.interval === interval ? "" : "none";
        });
        // The badge belongs to the yearly price, not to the tier. Picking one
        // of two tiers is not a recommendation; two months free is a fact.
        var flag = document.getElementById("price-flag");
        if (flag) flag.hidden = interval !== "year";
        var cta = document.getElementById("checkout-btn");
        if (cta) cta.dataset.interval = interval;
      });
    });
  }

  var checkoutBtn = document.getElementById("checkout-btn");
  if (checkoutBtn) {
    var checkoutMsg = document.getElementById("checkout-msg");
    checkoutBtn.addEventListener("click", function () {
      checkoutBtn.disabled = true;
      checkoutMsg.className = "msg-line";
      checkoutMsg.textContent = "Opening secure checkout…";

      post("/billing/checkout/" + checkoutBtn.dataset.interval)
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || "Checkout unavailable");
          // Card details are entered on Stripe's domain, never here.
          window.location.href = data.url;
        })
        .catch(function (error) {
          checkoutBtn.disabled = false;
          checkoutMsg.className = "msg-line error";
          checkoutMsg.textContent = error.message;
        });
    });
  }

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

      var steer = document.getElementById("remix-instructions");
      post("/api/remix/" + remixBtn.dataset.postId, {
        angles: angles,
        instructions: steer ? steer.value.trim() : ""
      })
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

      // Same markup the server renders for a saved variant, so one delegated
      // handler drives both. The hook and body ride on the button as data.
      var graphic = document.createElement("button");
      graphic.type = "button";
      graphic.className = "graphic-btn";
      graphic.textContent = "Generate graphic";
      graphic.dataset.hook = variant.hook || variant.body || "";
      graphic.dataset.body = variant.body || "";

      head.appendChild(angle);
      head.appendChild(copy);
      head.appendChild(graphic);

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

  /* ---------------------------------------------------- score explainer */

  // A plain-language popup for the score, filled with the clicked post's own
  // numbers. Every value comes from data-* attributes the server rendered —
  // counts and the tier label — so there is no user-authored text to escape.
  (function () {
    var modal = document.getElementById("score-help");
    if (!modal) return;
    var bodyEl = document.getElementById("score-help-body");

    function commas(n) {
      var v = parseFloat(n);
      return isNaN(v) ? String(n) : v.toLocaleString("en-US");
    }

    function explainHTML(d) {
      var isComment = d.kind === "comment";
      var thing = isComment ? "comment" : "post";
      var place = isComment ? "thread" : "group";
      var pool = isComment ? "comments in this source" : "posts in this group";
      var medWord = isComment ? "comment median" : "group median";
      return (
        '<p>Every ' + thing + ' is scored against what is <b>normal for its ' + place +
          '</b> — never a global number, because ' + commas(d.typical) +
          ' is a lot in a quiet ' + place + ' and little in a busy one.</p>' +
        '<p class="sh-formula">Weighted = reactions + comments&times;3 + shares&times;5' +
          '<span>comments and shares take more than a tap, so they count for more</span></p>' +
        '<p class="sh-math"><b>' + commas(d.reactions) + '</b> + <b>' + commas(d.comments) +
          '</b>&times;3 + <b>' + commas(d.shares) + '</b>&times;5 = <b>' + commas(d.weighted) +
          '</b> weighted</p>' +
        '<p>Typical here — the <b>' + medWord + '</b> — is <b>' + commas(d.typical) +
          '</b>, the middle score of all ' + pool +
          '. The median, not the average, so one viral ' + thing + " can't skew it.</p>" +
        '<p class="sh-multiple"><b>' + commas(d.weighted) + ' &divide; ' + commas(d.typical) +
          ' = ' + d.multiple + '&times;</b> &middot; ' + (d.tier || "") + "</p>" +
        '<div class="sh-bar" aria-hidden="true"><div class="sh-bar-fill"></div>' +
          '<div class="sh-bar-notch"><span>median</span></div></div>' +
        '<p class="sh-note">On the card, the notch is that median line and the glow is ' +
          "how far this " + thing + " cleared it.</p>"
      );
    }

    function openHelp(d) {
      bodyEl.innerHTML = explainHTML(d);
      modal.hidden = false;
      document.body.classList.add("score-help-open");
    }
    function closeHelp() {
      modal.hidden = true;
      document.body.classList.remove("score-help-open");
    }

    document.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-score-info]");
      if (trigger) { event.preventDefault(); openHelp(trigger.dataset); return; }
      if (event.target.closest("[data-score-close]")) { closeHelp(); }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !modal.hidden) closeHelp();
    });
  })();
})();
