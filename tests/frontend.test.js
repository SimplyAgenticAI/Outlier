/* The dashboard's JavaScript is one IIFE.
 *
 * A single uncaught error therefore takes down EVERY handler defined after
 * it, on every page. It happened: the connect block was made to run on all
 * pages so the extension could be handed a key wherever the user was, but
 * its button only exists on Capture and Account. addEventListener on null
 * threw, and the pricing page's plan toggle and checkout button — both
 * defined further down the file — silently never bound. Clicking either did
 * nothing, with no visible error anywhere.
 *
 * Rather than grep for the shape of that mistake, this runs the file against
 * a page containing NONE of its elements, which is the property that
 * actually matters: every page is missing most of them.
 */
var fs = require("fs");
var path = require("path");

var SRC = path.join(__dirname, "..", "static", "js", "outlier.js");
var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

/* A page with nothing on it. getElementById always returns null and every
 * query comes back empty — the worst case any page can present. */
function emptyPage() {
  function el() {
    var e = {
      style: {}, dataset: {}, classList: {
        add: function () {}, remove: function () {}, contains: function () { return false; }
      },
      children: [], attrs: {}, textContent: "", innerHTML: "", value: "",
      appendChild: function (c) { return c; },
      removeChild: function () {},
      prepend: function () {},
      remove: function () {},
      setAttribute: function (k, v) { e.attrs[k] = v; },
      getAttribute: function (k) { return e.attrs[k] === undefined ? null : e.attrs[k]; },
      addEventListener: function () {},
      removeEventListener: function () {},
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      closest: function () { return null; },
      focus: function () {},
      getBoundingClientRect: function () {
        return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
      }
    };
    return e;
  }

  var body = el();
  global.document = {
    body: body,
    documentElement: el(),
    readyState: "complete",
    title: "Tallgrass",
    createElement: el,
    createElementNS: el,
    getElementById: function () { return null; },       // nothing exists
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    removeEventListener: function () {}
  };

  global.window = {
    location: { href: "https://dash.test/pricing", pathname: "/pricing",
                origin: "https://dash.test", reload: function () {} },
    matchMedia: function () { return { matches: false, addEventListener: function () {} }; },
    sessionStorage: { getItem: function () { return null; },
                      setItem: function () {}, removeItem: function () {} },
    addEventListener: function () {}, removeEventListener: function () {},
    dispatchEvent: function () {}, scrollTo: function () {},
    getComputedStyle: function () { return {}; },
    innerWidth: 1280, innerHeight: 800
  };
  global.matchMedia = global.window.matchMedia;
  global.performance = { now: function () { return 0; } };
  global.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
  global.IntersectionObserver = function () {
    return { observe: function () {}, unobserve: function () {}, disconnect: function () {} };
  };
  global.WeakSet = WeakSet;
  global.fetch = function () { return Promise.resolve({ status: 200, json: function () { return Promise.resolve({}); } }); };
  global.CustomEvent = function (t, o) { this.type = t; Object.assign(this, o); };
}

console.log("the script survives a page with none of its elements");
emptyPage();
var threw = null;
try {
  new Function(fs.readFileSync(SRC, "utf8"))();
} catch (err) {
  threw = err && err.message ? err.message : String(err);
}
check("nothing is thrown", threw, null);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("frontend behaves");
process.exit(0);
