/* Invisible characters in text read off the page.
 *
 * A captured post came back reading like line noise: 120 characters, of which
 * 60 were U+034F COMBINING GRAPHEME JOINER — one after every visible letter.
 * Facebook interleaves them to break string matching. They render as nothing,
 * so they are stripped from every body and author name.
 *
 * Skipping those posts as ads was tried and reverted. The label really is an
 * anagram of "Sponsored" by the time it reaches us, and detecting it passed
 * every fixture here — but on the live page it rejected real posts, and a
 * scan of sixty returned eight. Fixtures could not reproduce it, so rather
 * than ship a narrower guess the rejection was removed outright. Ads come in
 * as ordinary rows, which is a visible, deletable problem; posts silently
 * vanishing is not.
 *
 * What survives is the part that was provably safe: the cleaning. It never
 * rejects anything, so it cannot cost a capture.
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

var CGJ = "\u034f";
var REPORTED = "edrposonStlfh9uhf91r84a 2l2t11a0h0e9Lget1llf11g70a249o6rhM6n"
  .split("").join(CGJ) + CGJ;

var api = runScan(buildPage([]), "/groups/1/");

console.log("the invisible characters come out");

check("the reported string really is half invisible", REPORTED.length, 120);
check("stripping leaves only what a human can see",
      api.visibleText(REPORTED).length, 60);
check("zero-width space and joiners go too",
      api.visibleText("a\u200bb\u200cc\u200dd"), "abcd");
check("so does the byte order mark", api.visibleText("a\ufeffb"), "ab");
check("and the soft hyphen", api.visibleText("co\u00adoperate"), "cooperate");

console.log();
console.log("real text is never touched");

/* The property that matters most. Stripping runs on every body and every
 * author name, so anything it damages is damage to a capture. */
[
  "Morning everyone! Just closed my 3rd deal this month \ud83c\udf89",
  "Here's the exact script I used \u2014 DM me if you want it",
  "Caf\u00e9 r\u00e9sum\u00e9 na\u00efve \u2014 accents and emoji \ud83c\udf3e",
  "Line one\nLine two\tTabbed",
  "Numbers 1,234 and 5.6K and 100%",
  "\u041f\u043b\u043e\u0445\u043e\u0439 \u0434\u0435\u043d\u044c\u3002\u4eca\u65e5\u306f\u3044\u3044\u5929\u6c17"
].forEach(function (sample) {
  check("left alone: " + sample.slice(0, 34), api.visibleText(sample), sample);
});

console.log();
console.log("nothing is rejected for looking like an ad");

/* The regression this file now guards. Every one of these was discarded by
 * the detection that has been removed, or could have been. */
var page = buildPage([
  { body: "First real post in the group", likes: 120, comments: 8, shares: 3 },
  { body: REPORTED, likes: 9000, comments: 1, shares: 0 },
  { body: "What I learned running sponsored ads last year", likes: 75, comments: 4 },
  { body: "Suggested for you", likes: 12, comments: 1 },
  { body: "Sponsored", likes: 40, comments: 2 }
]);
var scan = runScan(page, "/groups/1234567890/");
scan.scanPosts();
check("every post on the page is captured", scan.queue().length, 5);
check("  including the one about sponsored ads",
      scan.queue().some(function (p) { return /running sponsored ads/.test(p.body || ""); }), true);
check("  and no captured body still carries a joiner",
      scan.queue().some(function (p) { return (p.body || "").indexOf(CGJ) !== -1; }), false);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("text behaves");
process.exit(0);
