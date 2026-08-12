/* Which text block becomes the caption.
 *
 * Posts were arriving with bodies like
 *
 *   eStdrspono5el0cc6lalaln5rhh41 0Mifhf13r47a98g073a2uuo603ce8L
 *
 * interleaved with U+034F COMBINING GRAPHEME JOINER: sixty joiners in a
 * hundred and twenty characters, one after every visible letter. Facebook
 * plants these blocks to defeat text matching. The caption is chosen by
 * length, so a decoy longer than the real copy wins and the post arrives with
 * gibberish where its words should be. Some posts read correctly and some did
 * not, which is exactly what "whichever block happened to be longer" looks
 * like.
 *
 * I first called these ads. That was wrong. The evidence was that one
 * sample's first nine letters sorted to "sponsored" — and the next sample's
 * did not, which I noted and then ignored. They are decoys, not labels.
 *
 * THE PROPERTY THAT MATTERS: this decides which block becomes the caption and
 * nothing else. Every branch still captures the post. A post whose every
 * block is a decoy arrives with no caption, exactly like a post that never
 * had one — it does not go missing. That is the difference between this and
 * the change that cost a day.
 *
 * Written without literal emoji on purpose: escapes survive being rewritten
 * by tooling, and a mangled fixture here would fail for reasons that have
 * nothing to do with the code under test.
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
var ZWJ = "‍";
var MAN = "👨", WOMAN = "👩";

// The exact shape reported: every character followed by a joiner.
var DECOY = "eStdrspono5el0cc6lalaln5rhh41 0Mifhf13r47a98g073a2uuo603ce8L"
  .split("").join(CGJ) + CGJ;

var api = runScan(buildPage([]), "/groups/1/");

console.log("a decoy is recognised by its interleaving, not its content");

check("the reported string is a decoy", api.isDecoyText(DECOY), true);
check("  and it really is half invisible",
      (DECOY.match(/͏/g) || []).length, 60);

console.log();
console.log("real writing is never mistaken for one");

[
  "Morning everyone! Just closed my 3rd deal this month",
  "Here's the exact script I used - DM me if you want it",
  "Café résumé naïve, accents and 1,234 numbers",
  "Плохой день。今日はいい天気",
  "short",
  MAN + ZWJ + WOMAN + " a family emoji, held together by joiners",
  "A caption with a soft­hyphen in one word"
].forEach(function (real) {
  check("not a decoy: " + real.slice(0, 38), api.isDecoyText(real), false);
});

console.log();
console.log("cleaning never damages real text");

check("an emoji family survives intact",
      api.visibleText(MAN + ZWJ + WOMAN), MAN + ZWJ + WOMAN);
// The joiner fuses two glyphs into one; stripping it would split a family
// emoji into separate people, which is why it is deliberately not stripped.
check("  because the zero-width JOINER is structural, not noise",
      api.visibleText(MAN + ZWJ + WOMAN).indexOf(ZWJ) !== -1, true);
check("accents and dashes are untouched",
      api.visibleText("Café — résumé"), "Café — résumé");
check("the joiners themselves are removed",
      api.visibleText("a" + CGJ + "b" + CGJ), "ab");

console.log();
console.log("the real caption wins over a longer decoy");

var page = buildPage([{ body: "The real caption, shorter than the noise", likes: 120 }]);
var scan = runScan(page, "/groups/1234567890/");

// The decoy, longer than the caption, which is why it used to win.
var art = global.document.querySelectorAll('div[role="article"]')[0];
var decoyBlock = page.doc.el("div");
decoyBlock.setAttribute("dir", "auto");
decoyBlock.textContent = DECOY;
art.appendChild(decoyBlock);

scan.scanPosts();
var post = scan.queue()[0];
check("the post is captured", scan.queue().length, 1);
check("  with its own words", post && post.body,
      "The real caption, shorter than the noise");
check("  and no joiner survives in it", post && post.body.indexOf(CGJ), -1);

console.log();
console.log("a post that is ALL decoy is still captured");

var junkOnly = buildPage([{ body: DECOY, likes: 77, comments: 5, shares: 2 }]);
var junkApi = runScan(junkOnly, "/groups/1234567890/");
junkApi.scanPosts();
var junkPost = junkApi.queue()[0];

check("it is still queued", junkApi.queue().length, 1);
check("  with its engagement intact", junkPost && junkPost.likes, 77);
check("  and no gibberish in the caption",
      junkPost && (junkPost.body || "").indexOf(CGJ), -1);

junkApi.flush();
check("  and it reaches the dashboard", junkApi.stats().sent, 1);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("captions behave");
process.exit(0);
