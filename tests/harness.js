/* Shared test harness: a DOM stub good enough to load content.js and
 * exercise its real exported functions.
 *
 * The tests used to slice content.js by text markers and eval the
 * fragments. That is how a hundred and fifty duplicated lines hid in the
 * file for days -- the tests were reading a substring, not the module the
 * browser runs. Everything now loads the actual file.
 */
var path = require("path");
var SRC = path.join(__dirname, "..", "extension", "content.js");

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
    // Selector support matching what content.js actually uses, including
    // the substring form ([aria-label*="Messenger" i]) -- without it this
    // harness silently passes selectors it cannot evaluate.
    e.matchesSel = function (sel) {
      return String(sel).split(",").some(function (part) {
        part = part.trim();
        var m = part.match(
          /^([a-zA-Z]+)?(?:\[([^\]~^$*|=]+)(?:([~^$*|]?=)"([^"]*)")?(\s+i)?\])?$/
        );
        if (!m || (!m[1] && !m[2])) { return false; }
        if (m[1] && e.tagName !== m[1].toUpperCase()) { return false; }
        if (m[2]) {
          var v = e.getAttribute(m[2].trim());
          if (v === null) { return false; }
          if (m[4] !== undefined) {
            var want = m[4], have = v;
            if (m[5]) { want = want.toLowerCase(); have = have.toLowerCase(); }
            if (m[3] === "*=") { return have.indexOf(want) !== -1; }
            return have === want;
          }
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


module.exports = { makeDoc: makeDoc, buildPage: buildPage, runScan: runScan, SRC: SRC };
