/* Ads, and the characters Facebook hides inside text to stop it matching.
 *
 * A captured post came back reading like line noise:
 *
 *   edrposonStlfh9uhf91r84a 2l2t11a0h0e9Lget1llf11g70a249o6rhM6n
 *
 * interleaved with sixty U+034F COMBINING GRAPHEME JOINERs, one after every
 * visible character. Two separate faults were behind it.
 *
 * The joiners are Facebook breaking string matching. They render as nothing.
 *
 * And the text is not random: the first nine letters are an anagram of
 * "Sponsored". Facebook scatters that word across separate spans, reorders
 * them visually with CSS and pads the result with decoys, so no amount of
 * searching for the word finds it. Sorting the letters does, which is why
 * that is the test.
 *
 * The ad mattering is the part worth being clear about. A sponsored post's
 * reach is bought, so its engagement describes a budget rather than the
 * group — and every score in this app is a comparison against its source's
 * median. Each ad let through does not merely add a junk row: it moves the
 * number every other post in that group is judged against.
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

var CGJ = "͏";

// The string exactly as it was stored, joiners and all.
var REPORTED = "edrposonStlfh9uhf91r84a 2l2t11a0h0e9Lget1llf11g70a249o6rhM6n"
  .split("").join(CGJ) + CGJ;

var api = runScan(buildPage([]), "/groups/1/");

console.log("the invisible characters come out");

check("the reported string really is half invisible", REPORTED.length, 120);
check("stripping leaves only what a human can see",
      api.visibleText(REPORTED).length, 60);
check("and the joiners are all gone",
      api.visibleText(REPORTED).indexOf(CGJ), -1);

check("zero-width space is stripped too",
      api.visibleText("a​b‌c‍d"), "abcd");
check("so is the byte order mark", api.visibleText("a﻿b"), "ab");
check("ordinary text is left exactly alone",
      api.visibleText("Real post copy — em dash, accents: café, emoji 🌾"),
      "Real post copy — em dash, accents: café, emoji 🌾");

console.log();
console.log("the ad is recognised through the scrambling");

check("the reported string is caught", api.looksSponsored(REPORTED), true);
check("  and so is the plain word", api.looksSponsored("Sponsored"), true);
check("  whatever its case", api.looksSponsored("SPONSORED"), true);
check("  and a paid partnership label", api.looksSponsored("Paid partnership"), true);
check("  and Facebook's suggestions", api.looksSponsored("Suggested for you"), true);

/* Any shuffling of those letters is the same label. This is the property a
 * literal match cannot have, and the whole reason for sorting. */
check("any other shuffling of the letters is caught",
      api.looksSponsored("dsnooprse" + CGJ + "x"), true);

console.log();
console.log("real posts are not thrown away with them");

/* The case that decides whether this is safe to ship. Somebody's genuine
 * post about advertising contains the word and must survive: it is neither
 * short enough to be a label nor obfuscated, and both have to be true. */
check("a post ABOUT ads is still a post",
      api.looksSponsored("Here is what I learned running sponsored ads last year"),
      false);
check("ordinary copy is untouched",
      api.looksSponsored("Morning everyone, three things that worked this week"), false);
check("a nine-letter word that is not the anagram is fine",
      api.looksSponsored("wonderful marketing advice"), false);
check("an author's name is not an ad",
      api.looksSponsored("Rebecca Sandersonn"), false);

console.log();
console.log("an ad in a group is not captured at all");

/* Two real posts and one ad. The ad must not reach the queue — if it did it
 * would join the source's median and move every score in the group. */
var mixed = buildPage([
  { body: "First real post, plenty of engagement here", likes: 300, comments: 20, shares: 5 },
  { body: REPORTED, likes: 9000, comments: 1, shares: 0 },
  { body: "Second real post from a member", likes: 80, comments: 4, shares: 1 }
]);
var scan = runScan(mixed, "/groups/1234567890/");
scan.scanPosts();
var queued = scan.queue();

check("only the real posts are queued", queued.length, 2);
check("  and the ad's inflated numbers are nowhere in them",
      queued.some(function (p) { return p.likes === 9000; }), false);
check("no queued body still contains a joiner",
      queued.some(function (p) { return (p.body || "").indexOf(CGJ) !== -1; }), false);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("ads are kept out");
process.exit(0);
