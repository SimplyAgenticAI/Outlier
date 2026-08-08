/* detectSource across every surface Facebook serves posts on. */
var src = require("fs").readFileSync(
  require("path").join(__dirname, "..", "extension", "content.js"), "utf8");

var cases = [
  { url: "https://www.facebook.com/groups/claudeai", title: "Claude AI Community | Facebook",
    expect: { fb_id: "group:claudeai", kind: "group" } },
  { url: "https://www.facebook.com/groups/feed/", title: "Groups | Facebook",
    expect: { fb_id: "feed:groups", kind: "feed", perPost: true } },
  { url: "https://www.facebook.com/", title: "Facebook",
    expect: { fb_id: "feed:home", kind: "feed", perPost: true } },
  { url: "https://www.facebook.com/home.php", title: "Facebook",
    expect: { fb_id: "feed:home", kind: "feed" } },
  { url: "https://www.facebook.com/profile.php?id=100001234567890", title: "Jane Doe | Facebook",
    expect: { fb_id: "profile:100001234567890" } },
  { url: "https://www.facebook.com/pages/Some-Business/987654321", title: "Some Business | Facebook",
    expect: { fb_id: "page:987654321", kind: "page" } },
  { url: "https://www.facebook.com/janedoe", title: "Jane Doe | Facebook",
    expect: { fb_id: "profile:janedoe", kind: "profile" }, page: false },
  { url: "https://www.facebook.com/AcmeCorp", title: "Acme Corp | Facebook",
    expect: { fb_id: "page:AcmeCorp", kind: "page" }, page: true },
  { url: "https://www.facebook.com/marketplace", title: "Marketplace | Facebook",
    expect: null },
  { url: "https://www.facebook.com/watch", title: "Watch | Facebook", expect: null },
];

var failures = 0;
cases.forEach(function (c) {
  var mainText = c.page ? "12,400 followers  ·  Following" : "830 friends  ·  Add friend";
  global.location = Object.assign(new URL(c.url), {});
  global.document = {
    title: c.title,
    querySelector: function (sel) {
      if (sel.indexOf("role=\"main\"") !== -1) return { innerText: mainText };
      if (sel.indexOf("aria-label=\"Like\"") !== -1) return null;
      return null;
    },
    querySelectorAll: function () { return []; },
    body: { innerText: mainText },
  };
  global.window = { location: global.location };
  global.URL = URL;

  var code = src.slice(src.indexOf("  var RESERVED_SLUGS"), src.indexOf("  /* Which source a single article"));
  var helpers = src.slice(src.indexOf("  function nameFromTitle"), src.indexOf("  function detectSource"));
  var got;
  eval(helpers + code + "\ngot = detectSource();");

  var ok;
  if (c.expect === null) ok = (got === null);
  else ok = got && Object.keys(c.expect).every(function (k) { return got[k] === c.expect[k]; });

  if (!ok) { failures++; console.log(" FAIL " + c.url + "\n       got " + JSON.stringify(got)); }
  else console.log("  ok  " + c.url.replace("https://www.facebook.com", "") +
                   "  ->  " + (got ? got.kind + " / " + got.fb_id : "unsupported"));
});
console.log(failures ? "\n" + failures + " FAILURES" : "\nall " + cases.length + " surfaces correct");
process.exit(failures ? 1 : 0);
