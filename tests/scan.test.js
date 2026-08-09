/* Does a scan actually capture posts?
 *
 * This is the test that was missing, and its absence cost a release. V3.6
 * shipped a scan loop that clicked "See more" and returned, expecting the
 * next sweep to capture the post. When the control did not vanish, the post
 * was skipped on that pass and every pass after it, and the counter sat at
 * zero. Every other test still passed, because none of them ran a scan.
 */
var path = require("path");
var SRC = path.join(__dirname, "..", "extension", "content.js");

var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

/* ------------------------------------------------------------------ DOM -- */

function makeDoc() {
  var all = [];

  function el(tag) {
    var e = {
      tagName: String(tag).toUpperCase(), attrs: {}, children: [],
      parentElement: null, style: {}, _text: "", clicked: 0, onClick: null
    };
    e.setAttribute = function (k, v) { e.attrs[k] = String(v); };
    e.getAttribute = function (k) {
      return e.attrs[k] === undefined ? null : e.attrs[k];
    };
    e.hasAttribute = function (k) { return e.attrs[k] !== undefined; };
    e.appendChild = function (c) {
      c.parentElement = e; e.children.push(c); all.push(c); return c;
    };
    e.addEventListener = function () {};
    e.click = function () { e.clicked += 1; if (e.onClick) e.onClick(); };
    Object.defineProperty(e, "textContent", {
      get: function () {
        var kids = e.children.map(function (c) { return c.textContent; }).join(" ");
        return (e._text + " " + kids).trim();
      },
      set: function (v) { e._text = String(v); }
    });
    Object.defineProperty(e, "innerText", {
      get: function () { return e.textContent; },
      set: function (v) { e._text = String(v); }
    });
    e.descendants = function () {
      return e.children.reduce(function (acc, c) {
        return acc.concat([c], c.descendants());
      }, []);
    };
    // Enough selector support for the shapes content.js actually uses.
    e.matchesSel = function (sel) {
      return String(sel).split(",").some(function (part) {
        var m = part.trim().match(/^([a-zA-Z]+)?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/);
        if (!m || (!m[1] && !m[2])) { return false; }
        if (m[1] && e.tagName !== m[1].toUpperCase()) { return false; }
        if (m[2]) {
          var v = e.getAttribute(m[2]);
          if (v === null) { return false; }
          if (m[3] !== undefined && v !== m[3]) { return false; }
        }
        return true;
      });
    };
    e.querySelectorAll = function (sel) {
      return e.descendants().filter(function (d) { return d.matchesSel(sel); });
    };
    e.querySelector = function (sel) { return e.querySelectorAll(sel)[0] || null; };
    e.closest = function (sel) {
      var n = e;
      while (n) {
        if (n.matchesSel && n.matchesSel(sel)) { return n; }
        n = n.parentElement;
      }
      return null;
    };
    e.compareDocumentPosition = function (other) {
      return all.indexOf(other) > all.indexOf(e) ? 4 : 0;   // FOLLOWING
    };
    e.getBoundingClientRect = function () {
      return { top: 0, left: 0, width: 600, height: 400, bottom: 400, right: 600 };
    };
    e.remove = function () {};
    all.push(e);
    return e;
  }

  return { el: el, all: all };
}

/* A page of Facebook-shaped articles. */
function buildPage(specs) {
  var D = makeDoc();
  var root = D.el("div");

  specs.forEach(function (spec, i) {
    var art = D.el("div");
    art.setAttribute("role", "article");

    var head = D.el("a");
    head.setAttribute("role", "link");
    head.textContent = spec.author || ("Author Person " + i);
    art.appendChild(head);

    var body = D.el("div");
    body.setAttribute("dir", "auto");
    body.textContent = spec.body;
    art.appendChild(body);

    if (spec.seeMore) {
      var more = D.el("div");
      more.setAttribute("role", "button");
      more.textContent = "See more";
      // sticky = a control that survives the click. The V3.6 killer.
      if (!spec.sticky) { more.onClick = function () { more._text = ""; }; }
      art.appendChild(more);
    }

    var counts = D.el("div");
    counts.setAttribute("aria-label", spec.likes + " reactions");
    art.appendChild(counts);

    // Real posts expose a Share control and a tally; a fixture without them
    // is the "no signals" case, which must still be captured.
    if (!spec.bare) {
      var share = D.el("div");
      share.setAttribute("aria-label", "Send this to friends or post it on your profile");
      art.appendChild(share);
      var tally = D.el("div");
      tally.setAttribute("aria-label", "12 comments");
      art.appendChild(tally);
    }

    var bar = D.el("div");
    bar.setAttribute("role", "button");
    bar.setAttribute("aria-label", "Like");
    bar.textContent = "Like Comment Share";
    art.appendChild(bar);

    root.appendChild(art);
  });

  return { doc: D, root: root };
}

/* -------------------------------------------------------------- harness -- */

function runScan(page, urlPath) {
  var stored = { enabled: true, endpoint: "https://dash.test", apiKey: "olk_x" };

  global.chrome = {
    runtime: {
      getManifest: function () { return { version: "0.27.0" }; },
      lastError: null, id: "x",
      sendMessage: function (m, cb) {
        if (cb) { cb({ ok: true, new: (m.posts || []).length }); }
      },
      onMessage: { addListener: function () {} }
    },
    storage: {
      local: {
        get: function (keys, cb) { cb(stored); },
        set: function (o, cb) { Object.assign(stored, o); if (cb) { cb(); } }
      },
      onChanged: { addListener: function () {} }
    },
    alarms: { create: function () {}, onAlarm: { addListener: function () {} } },
    permissions: { contains: function (o, cb) { cb(true); } }
  };

  global.document = {
    title: "Audience Growth Lab | Facebook",
    body: page.root, documentElement: page.root, readyState: "complete",
    createElement: page.doc.el,
    createElementNS: function (ns, t) { return page.doc.el(t); },
    querySelector: function (s) { return page.root.querySelector(s); },
    querySelectorAll: function (s) { return page.root.querySelectorAll(s); },
    addEventListener: function () {}, removeEventListener: function () {}
  };

  global.location = new URL("https://www.facebook.com" + urlPath);
  global.window = {
    location: global.location, innerWidth: 1440, innerHeight: 900,
    scrollY: 0, scrollX: 0,
    matchMedia: function () {
      return { matches: false, addEventListener: function () {} };
    },
    addEventListener: function () {}, removeEventListener: function () {},
    dispatchEvent: function () {}, scrollTo: function () {},
    getComputedStyle: function () { return {}; }
  };
  global.navigator = {
    clipboard: { writeText: function () { return Promise.resolve(); } }
  };
  global.MutationObserver = function () {
    return { observe: function () {}, disconnect: function () {} };
  };
  global.ResizeObserver = global.MutationObserver;
  global.IntersectionObserver = global.MutationObserver;
  global.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
  global.CustomEvent = function (t, o) { this.type = t; Object.assign(this, o); };
  global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  global.URL = URL;
  global.matchMedia = global.window.matchMedia;

  delete require.cache[require.resolve(SRC)];
  require(SRC);
  return global.window.__outlier;
}

/* ---------------------------------------------------------------- tests -- */

console.log("a scan of ordinary posts");
var api = runScan(buildPage([
  { body: "First post about growing an audience organically over a long time.", likes: 120 },
  { body: "Second post with a different angle on the very same subject here.", likes: 340 },
  { body: "Third post, still with a decent amount of caption text on it.", likes: 90 }
]), "/groups/growth");
api.scanPosts();
check("the queue is not empty", api.queue().length > 0);
check("every post captured", api.queue().length, 3);
check("bodies stored", api.queue().every(function (p) {
  return p.body && p.body.length > 10;
}));
check("engagement read", api.queue().map(function (p) { return p.likes; }), [120, 340, 90]);

console.log("a post whose See more never goes away");
var stickyPage = buildPage([
  { body: "A long clamped caption Facebook will not let go of, ever.",
    likes: 200, seeMore: true, sticky: true },
  { body: "An ordinary post beside it with plenty of caption text.", likes: 55 }
]);
var api2 = runScan(stickyPage, "/groups/growth");
api2.scanPosts();
api2.scanPosts();                       // second sweep: control still present
check("the sticky post is STILL captured", api2.queue().length, 2);
check("See more was clicked", stickyPage.root
  .querySelectorAll('div[role="button"]')
  .some(function (b) { return b.clicked > 0; }));

console.log("a post that expands on click");
var api3 = runScan(buildPage([
  { body: "Short fragment of a caption here", likes: 70, seeMore: true }
]), "/groups/growth");
api3.scanPosts();
check("captured on the first pass, not deferred", api3.queue().length, 1);

console.log("an article with no recognisable signals");
var api5 = runScan(buildPage([
  { body: "A post on a page whose markup exposes none of the usual signals.",
    likes: 33, bare: true }
]), "/groups/growth");
api5.scanPosts();
check("captured rather than silently dropped", api5.queue().length, 1);

console.log("comments are counted, never captured");
var wc = buildPage([
  { body: "A real post with a decent amount of caption text on it.", likes: 400 }
]);
var art = wc.root.children[0];
var reply = wc.doc.el("div");
reply.setAttribute("role", "article");
var replyBody = wc.doc.el("div");
replyBody.setAttribute("dir", "auto");
replyBody.textContent = "A reply Facebook decided to preview under this post";
reply.appendChild(replyBody);
var replyBtn = wc.doc.el("div");
replyBtn.setAttribute("role", "button");
replyBtn.textContent = "Reply";
reply.appendChild(replyBtn);
art.appendChild(reply);

var api4 = runScan(wc, "/groups/growth");
api4.scanPosts();
check("nothing in the queue is a comment", api4.queue().every(function (p) {
  return p.item_type === "post";
}));

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("scan behaves");
// The content script installs timers and observers; without this the process
// stays alive after the assertions have all run.
process.exit(0);
