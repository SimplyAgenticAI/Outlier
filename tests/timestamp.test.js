/* When a post was actually written.
 *
 * A whole scan came back with every post claiming the same age — "posted 15
 * hours ago" on all of them — which was the moment of the scan, not the
 * posts. extractTimestamp fell through to `new Date()` whenever it could not
 * read a date, so posts were being stamped with their capture time and there
 * was no way to tell that from a real reading.
 *
 * It could not read most of them because the parser understood "2h" and
 * essentially nothing else: it required a word boundary immediately after the
 * unit letter, so every spelled-out form failed on its own second character —
 * "hours" is h followed by o. Facebook uses the spelled-out and absolute
 * forms constantly, in aria-label and title attributes.
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

var api = runScan(buildPage([]), "/groups/1/");
var parse = api.parseRelativeTime;

function hoursAgo(iso) {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso + "Z").getTime()) / 36e5 * 10) / 10;
}

console.log("the compact header form");
check("2h  -> 2 hours ago", hoursAgo(parse("2h")), 2);
check("45m -> under an hour", hoursAgo(parse("45m")), 0.8);
check("3d  -> 72 hours", hoursAgo(parse("3d")), 72);
check("1w  -> 168 hours", hoursAgo(parse("1w")), 168);

console.log();
console.log("the spelled-out form, which used to fail on every single one");
check("2 hours ago", hoursAgo(parse("2 hours ago")), 2);
check("15 minutes ago", hoursAgo(parse("15 minutes ago")), 0.3);
check("3 days ago", hoursAgo(parse("3 days ago")), 72);
check("1 hr ago", hoursAgo(parse("1 hr ago")), 1);
check("an hour ago", hoursAgo(parse("an hour ago")), 1);
check("Just now", hoursAgo(parse("Just now")), 0);

console.log();
console.log("named dates");
/* Stored in UTC, because that is what reads it back — so the expected value
 * is built as a LOCAL wall clock and converted the same way, rather than
 * asserting digits that only hold in one timezone. */
function localToStored(y, monthIndex, day, hh, mm) {
  return new Date(y, monthIndex, day, hh, mm, 0).toISOString().slice(0, 19);
}

var thisYear = new Date().getFullYear();
var augYear = new Date(thisYear, 7, 3) > new Date() ? thisYear - 1 : thisYear;
var aug = parse("August 3 at 10:14 AM");
check("August 3 at 10:14 AM is read", !!aug, true);
check("  as the third of August at 10:14 local",
      aug, localToStored(augYear, 7, 3, 10, 14));

check("August 3, 2025 keeps its year",
      parse("August 3, 2025"), localToStored(2025, 7, 3, 12, 0));
check("3 August 2025 reads the same",
      parse("3 August 2025"), localToStored(2025, 7, 3, 12, 0));

var yesterday = new Date(Date.now() - 864e5);
check("Yesterday at 7:30 PM is read as last night",
      parse("Yesterday at 7:30 PM"),
      localToStored(yesterday.getFullYear(), yesterday.getMonth(),
                    yesterday.getDate(), 19, 30));

console.log();
console.log("and nothing is invented");

/* The heart of it. Anything unreadable must come back empty, because a
 * fabricated time is indistinguishable from a real one once it is stored. */
[
  "", "   ", "See more", "Like Comment Share", "1,600 reactions",
  "Top contributor", "Follow", "Sponsored", "· ", "5 comments"
].forEach(function (junk) {
  check("no time invented from " + JSON.stringify(junk), parse(junk), null);
});

console.log();
console.log("a post with no readable date carries none");

var page = buildPage([{ body: "A post whose date is nowhere on the card", likes: 40 }]);
var scan = runScan(page, "/groups/1234567890/");
scan.scanPosts();
var queued = scan.queue()[0];
check("posted_at is empty rather than the time of capture",
      queued && queued.posted_at, null);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("timestamps behave");
process.exit(0);
