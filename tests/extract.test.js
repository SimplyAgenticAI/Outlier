/* Extraction, against the real module.
 *
 * Replaces the old engagement/see-more/surface tests, which sliced
 * content.js by text markers and eval'd the fragments — so they were testing
 * a substring rather than the file the browser loads. That is how a hundred
 * and fifty duplicated lines survived in the source unnoticed.
 */
var H = require("./harness");
var runScan = H.runScan, buildPage = H.buildPage, makeDoc = H.makeDoc;

var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

// Load the module once with an empty page; the pure helpers it exports do
// not depend on that page.
var api = runScan(buildPage([]), "/groups/growth");

/* --------------------------------------------------------------- counts -- */

console.log("what counts as a count");
[
  ["312", true], ["1.2K", true], ["45,678", true], ["2M", true],
  ["1.5B", true], ["12", true], ["1,234", true], ["8", true],
  ["5h", false], ["3d", false], ["2w", false], ["1y", false],
  ["2m", false], ["45m", false],
  ["2024", false], ["1999", false], ["10:30", false], ["3/4", false],
  ["abc", false], ["", false]
].forEach(function (c) {
  check("looksLikeACount(" + JSON.stringify(c[0]) + ")",
        api.looksLikeACount(c[0]), c[1]);
});

check("a number past the plausibility cap is refused", api.parseCount("99000000"), 0);
check("1.2K parses", api.parseCount("1.2K"), 1200);

/* ------------------------------------------------------------ image OCR -- */

console.log("text rendered into the graphic");
[
  ["May be an image of text that says 'SALE ENDS FRIDAY 50% OFF'", "SALE ENDS FRIDAY 50% OFF"],
  ["May be an image of 2 people and text that says 'We grew to 10k'", "We grew to 10k"],
  ["May be a graphic of text that says 'THE ONLY RULE: SHOW UP'", "THE ONLY RULE: SHOW UP"],
  ["May be an image of text that says 'A'", ""],
  ["May be an image of text", ""],
  ["No photo description available.", ""],
  ["May be an image of 3 people, outdoors", ""],
  ["Profile picture", ""],
  ["", ""]
].forEach(function (c) {
  check("textFromAlt(" + JSON.stringify(c[0].slice(0, 44)) + ")",
        api.textFromAlt(c[0]), c[1]);
});

/* ------------------------------------------------------------- surfaces -- */

console.log("which surface are we on");
[
  ["/groups/claudeai", "Claude AI Community | Facebook", false, "group:claudeai", "group"],
  ["/groups/feed/", "Groups | Facebook", false, "feed:groups", "feed"],
  ["/", "Facebook", false, "feed:home", "feed"],
  ["/home.php", "Facebook", false, "feed:home", "feed"],
  ["/profile.php?id=100001234567890", "Jane Doe | Facebook", false, "profile:100001234567890", "profile"],
  ["/pages/Some-Business/987654321", "Some Business | Facebook", false, "page:987654321", "page"],
  ["/janedoe", "Jane Doe | Facebook", false, "profile:janedoe", "profile"],
  ["/AcmeCorp", "Acme Corp | Facebook", true, "page:AcmeCorp", "page"],
  ["/marketplace", "Marketplace | Facebook", false, null, null],
  ["/watch", "Watch | Facebook", false, null, null]
].forEach(function (c) {
  var page = buildPage([]);
  // looksLikeAPage reads the main region's text.
  page.root.setAttribute("role", "main");
  page.root._text = c[2] ? "12,400 followers · Following"
                         : "830 friends · Add friend";
  var scoped = runScan(page, c[0]);
  global.document.title = c[1];
  var got = scoped.detectSource();
  check("detectSource(" + c[0] + ")",
        got ? [got.fb_id, got.kind] : null,
        c[3] ? [c[3], c[4]] : null);
});

/* ------------------------------------------------- engagement, in a post -- */

console.log("engagement is read from chrome, never from the caption");

// A post built by hand so the caption and the summary row are distinct
// elements, which is the distinction the whole guard rests on.
function postWith(opts) {
  var D = makeDoc();
  var root = D.el("div");
  root.setAttribute("role", "main");
  var art = D.el("div");
  art.setAttribute("role", "article");

  var head = D.el("a");
  head.setAttribute("role", "link");
  head.textContent = "Author Person";
  art.appendChild(head);

  var caption = D.el("div");
  caption.setAttribute("dir", "auto");
  caption.textContent = opts.caption || "";
  art.appendChild(caption);

  (opts.rows || []).forEach(function (text) {
    var r = D.el("div");
    r.setAttribute("dir", "auto");
    r.textContent = text;
    art.appendChild(r);
  });

  (opts.labels || []).forEach(function (label) {
    var n = D.el("div");
    n.setAttribute("aria-label", label);
    art.appendChild(n);
  });

  var bar = D.el("div");
  bar.setAttribute("role", "button");
  bar.setAttribute("aria-label", "Like");
  bar.textContent = "Like Comment Share";
  art.appendChild(bar);

  root.appendChild(art);
  return { doc: D, root: root, article: art };
}

function engagementOf(opts) {
  var page = postWith(opts);
  var scoped = runScan(page, "/groups/growth");
  var art = page.article;
  var bar = scoped.findActionBar(art);
  var author = scoped.extractAuthor(art, bar);
  var caption = scoped.extractBody(art, author.name, bar);
  return scoped.extractEngagement(art, bar, caption.el);
}

var e;

e = engagementOf({
  caption: "Anthropic says Claude processed 11,000,000 tokens in this run",
  labels: ["4 reactions"]
});
check("THE BUG: a caption's huge number is not the reaction count", e.likes, 4);

e = engagementOf({
  caption: "We processed 11,000,000 tokens and it cost 250,000 dollars",
  labels: []
});
check("a caption alone yields nothing", [e.likes, e.read], [0, false]);

e = engagementOf({ caption: "A normal post", labels: ["312 reactions", "47 comments", "12 shares"] });
check("labelled counts are read", [e.likes, e.comments, e.shares], [312, 47, 12]);

e = engagementOf({ caption: "A normal post", labels: ["1.2K reactions", "88 comments"] });
check("counts do not bleed across labels", [e.likes, e.comments], [1200, 88]);

e = engagementOf({
  caption: "Here is a reasonably long caption about our new product launch",
  rows: ["412"]
});
check("a bare summary row beside a caption still wins", e.likes, 412);

e = engagementOf({ caption: "Only 3 spots left!", labels: [] });
check("a SHORT caption with a number is not a count", [e.likes, e.read], [0, false]);

e = engagementOf({
  caption: "I bought 500 shares of the company last year and it doubled",
  labels: []
});
check("a caption using an engagement word is still not a count", e.shares, 0);

e = engagementOf({ caption: "A post", rows: ["5h"] });
check("a timestamp is not a count", [e.likes, e.read], [0, false]);

e = engagementOf({ caption: "A post", labels: ["Like, Love and 47 others"] });
check("'and 47 others' is read", e.likes, 47);

e = engagementOf({
  caption: "A post",
  labels: ["May be an image of text that says 5,000,000 SUBSCRIBERS"]
});
check("a generated image description yields no count", [e.likes, e.read], [0, false]);

e = engagementOf({ caption: "A post", labels: ["99000000 reactions"] });
check("an implausible count is refused", [e.likes, e.read], [0, false]);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("extraction behaves");
process.exit(0);
