/* Extraction, against the restored V1.7 capture script.
 *
 * The previous version of this file tested the rewritten extractors. Those
 * were reverted because they stopped capturing anything on real Facebook
 * pages, so this covers what the restored script actually does.
 *
 * KNOWN GAP, recorded deliberately rather than hidden: this version reads
 * engagement from the article's visible text, which includes the caption. A
 * post whose copy contains a large number can therefore have that number
 * stored as its reaction count — the "11,000,000 reactions" bug. The fix for
 * it (excluding the caption element structurally) is in git at 32765cb and
 * should be reapplied to THIS file once capture is confirmed working on a
 * real group. Fixing it first is what led to a scanner that captured
 * nothing, and a correct number nobody ever captures is worth nothing.
 */
var H = require("./harness");
var runScan = H.runScan, buildPage = H.buildPage;

var FAILURES = [];

function check(name, got, want) {
  if (arguments.length === 2) { want = true; }
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ok   " : " FAIL  ") + name +
    (ok ? "" : "   got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
  if (!ok) { FAILURES.push(name); }
}

var api = runScan(buildPage([]), "/groups/growth");

/* --------------------------------------------------------------- counts -- */

console.log("parsing counts");
check("plain", api.parseCount("312"), 312);
check("thousands", api.parseCount("1.2K"), 1200);
check("millions", api.parseCount("2M"), 2000000);
check("comma-grouped", api.parseCount("45,678"), 45678);
check("nothing", api.parseCount(""), 0);
// One value above the cap wrecks the median for every post scored against it.
check("a number past the plausibility cap is refused",
      api.parseCount("99000000"), 0);

/* ------------------------------------------------------------- surfaces -- */

console.log("which surface are we on");
[
  ["/groups/claudeai", "Claude AI Community | Facebook", "group:claudeai", "group"],
  ["/janedoe", "Jane Doe | Facebook", "profile:janedoe", "profile"],
  ["/marketplace", "Marketplace | Facebook", null, null],
  ["/watch", "Watch | Facebook", null, null]
].forEach(function (c) {
  var scoped = runScan(buildPage([]), c[0]);
  global.document.title = c[1];
  var got = scoped.detectSource();
  check("detectSource(" + c[0] + ")",
        got ? [got.fb_id, got.kind] : null,
        c[2] ? [c[2], c[3]] : null);
});

/* ----------------------------------------------------------- engagement -- */

console.log("engagement from a labelled post");
var page = buildPage([
  { body: "An ordinary post with a decent amount of caption text on it.",
    likes: 312 }
]);
var scoped = runScan(page, "/groups/growth");
scoped.scanPosts();
var first = scoped.queue()[0] || {};
check("the post is queued", !!first.fb_post_id);
check("its reaction count is read", first.likes, 312);
check("its caption is stored",
      /ordinary post with a decent amount/.test(first.body || ""));

console.log("a reaction summary with no wording");
// Facebook often renders the summary as a bare number beside the emoji
// icons. Every worded pattern misses it, so posts landed marked "not read".
var bare = buildPage([]);
var art = bare.doc.el("div");
art.setAttribute("role", "article");
var head = bare.doc.el("a");
head.setAttribute("role", "link");
head.textContent = "Dana Fletcher";
art.appendChild(head);
var cap = bare.doc.el("div");
cap.setAttribute("dir", "auto");
cap.textContent = "A post whose reaction count carries no label at all.";
art.appendChild(cap);
var count = bare.doc.el("span");        // just the number, no wording
count.textContent = "487";
art.appendChild(count);
var bar = bare.doc.el("div");
bar.setAttribute("role", "button");
bar.setAttribute("aria-label", "Like");
bar.textContent = "Like Comment Share";
art.appendChild(bar);
bare.root.appendChild(art);

var bareApi = runScan(bare, "/groups/growth");
bareApi.scanPosts();
var got = bareApi.queue()[0] || {};
check("the post is captured", !!got.fb_post_id);
check("the bare count is read as reactions", got.likes, 487);

// And the guard: a number inside a sentence is not a count.
var sentence = buildPage([
  { body: "We processed 11,000,000 tokens in the benchmark run this week.",
    likes: 0 }
]);
// strip the labelled count so only the caption remains
var sArt = sentence.root.children[0];
sArt.children.forEach(function (c) {
  if ((c.getAttribute("aria-label") || "").indexOf("reactions") !== -1) {
    c.setAttribute("aria-label", "");
  }
});
var sApi = runScan(sentence, "/groups/growth");
sApi.scanPosts();
var sGot = sApi.queue()[0] || {};
check("a number inside a caption is not read as a count",
      (sGot.likes || 0) < 11000000);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("extraction behaves");
process.exit(0);
