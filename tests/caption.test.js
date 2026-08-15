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
console.log("the joiner-free token decoy is caught too");

// Both strings are real: copied from captionless photo posts on the live
// dashboard, where each had become the post's "caption". No joiners at all —
// which is why the invisible-character test above misses them.
var TOKEN_A = "geLjcsfp06K3MSozzgloUsnxaHXa4lAU1iK8TZ0crfwx76heGenNPl";
var TOKEN_B = "Q60yj701njCNjxYWFmTQNtvVn5Dd0JNaaU09jgorkngXF3xsmjN";
check("first real token is a decoy", api.isDecoyText(TOKEN_A), true);
check("second real token is a decoy", api.isDecoyText(TOKEN_B), true);
check("  and it carries no joiners to catch it by",
      (TOKEN_B.match(/͏/g) || []).length, 0);

console.log();
console.log("a token decoy under thirty characters is caught too");

// Real, from the dashboard: twenty-six characters, so the old floor of thirty
// let it straight through into the caption.
check("twenty-six characters is still a decoy",
      api.isDecoyText("kzfuqdTwMaj4osRaigGNJeAvHM"), true);
// Between twenty and thirty the letters must spell nothing as well, so a real
// run-on caption keeps its place.
check("a real run-on is not a decoy",
      api.isDecoyText("iPhone15ProMaxUnlocked"), false);
check("nor is a long CamelCase phrase",
      api.isDecoyText("MondayMotivationForEveryone"), false);

console.log();
console.log("legitimate single-token captions are carved out");

[
  "https://example.com/aB3xZ9kQ7mNp2wL",                 // a link
  "www.macrandleacres.com/tallgrass",
  "@LynetteCunningham",                                   // a handle
  "#SpiritualAwakening2026",                              // a hashtag
  "Rindfleischetikettierungsuberwachungsaufgaben",        // a long real word, no digits
  "SAVE20"                                                // a short promo code
].forEach(function (real) {
  check("not a decoy: " + real.slice(0, 34), api.isDecoyText(real), false);
});

console.log();
console.log("a decoy dressed as a domain is caught");

// Real, from the dashboard: a captionless post arrived reading "Ghgb4e.com".
check("the fake domain is a decoy", api.isDecoyText("Ghgb4e.com"), true);
check("  even short and dotted", api.isDecoyText("Xk7Qz.io"), true);

// Real, from the dashboard again: requiring a digit alongside the capital
// missed every decoy that happened not to carry one.
check("  and with no digit at all", api.isDecoyText("YjDuBghsl.com"), true);
check("  the giveaway is five consonants", api.isDecoyText("QrtwbNkm.net"), true);
// Real, from the dashboard a third time: no digit AND no capital either.
// Caught on the opening cluster - no word begins "mr".
check("  and with no capital either", api.isDecoyText("mrukbzoeu.com"), true);
check("  an opening no word has", api.isDecoyText("kzfuqbo.net"), true);

console.log();
console.log("real links and domains are left alone");

[
  "mystore.com",              // clean lowercase
  "MyStore.com",              // brand casing, no digit
  "promo2024.com",            // worded promo with a digit, no caps
  "bit.ly",
  "linktr.ee",
  "https://example.com/aB3",  // a real URL with a path
  "www.macrandleacres.com",
  "TechCrunch.com",           // mixed case, runs to four consonants (chcr)
  "SHRM.com",                 // an acronym: too short to judge on spelling
  "HubSpot.com",              // mixed case, pronounceable
  "StackOverflow.com",
  "nfl.com",                  // three letters, exempt
  "espn.com",
  "shopify.com",              // "sh" is an opening words really have
  "squarespace.com",          // so is "sq"
  "linktr.ee"
].forEach(function (real) {
  check("not a decoy: " + real, api.isDecoyText(real), false);
});

console.log();
console.log("a real caption still wins over a token decoy");

var mixPage = buildPage([{ body: "Grateful for this community today", likes: 90 }]);
var mixScan = runScan(mixPage, "/groups/1234567890/");
var mixArt = global.document.querySelectorAll('div[role="article"]')[0];
var tokenBlock = mixPage.doc.el("div");
tokenBlock.setAttribute("dir", "auto");
tokenBlock.textContent = TOKEN_A;                          // longer than the caption
mixArt.appendChild(tokenBlock);
mixScan.scanPosts();
var mixPost = mixScan.queue()[0];
check("the post is captured", mixScan.queue().length, 1);
check("  with its own words, not the token", mixPost && mixPost.body,
      "Grateful for this community today");

console.log();
console.log("a captionless post whose only text is a token decoy");

var tokenOnly = buildPage([{ body: TOKEN_B, likes: 1500, comments: 42, shares: 863 }]);
var tokenApi = runScan(tokenOnly, "/groups/1234567890/");
tokenApi.scanPosts();
var tokenPost = tokenApi.queue()[0];
check("it is still queued", tokenApi.queue().length, 1);
check("  with its engagement intact", tokenPost && tokenPost.likes, 1500);
check("  and no token in the caption", tokenPost && (tokenPost.body || ""), "");

console.log();
console.log("the platform's own name is not a caption");

// Real, from the dashboard: captionless posts arrived with a body of exactly
// "Facebook", from an attribution or embed label that nothing outranked.
var fbOnly = buildPage([{ body: "", likes: 210, comments: 12, shares: 4 }]);
var fbApi = runScan(fbOnly, "/groups/1234567890/");
var fbArt = global.document.querySelectorAll('div[role="article"]')[0];
var fbBlock = fbOnly.doc.el("div");
fbBlock.setAttribute("dir", "auto");
fbBlock.textContent = "Facebook";
fbArt.appendChild(fbBlock);
fbApi.scanPosts();
var fbPost = fbApi.queue()[0];
check("the post is still queued", fbApi.queue().length, 1);
check("  with its engagement intact", fbPost && fbPost.likes, 210);
check("  and no platform name as the caption", fbPost && (fbPost.body || ""), "");

// The word is only chrome when it is the whole block; a post that talks about
// Facebook keeps every word of what it said.
var fbReal = buildPage([{ body: "Facebook keeps changing the group layout on us", likes: 33 }]);
var fbRealApi = runScan(fbReal, "/groups/1234567890/");
fbRealApi.scanPosts();
check("a caption that mentions it is untouched",
      fbRealApi.queue()[0] && fbRealApi.queue()[0].body,
      "Facebook keeps changing the group layout on us");

console.log();
console.log("what the picture SHOWS is read separately from what it SAYS");

// Facebook writes both into one alt string. The words belong in the body; the
// scene description never does - a machine's account of a photo is not
// something the author wrote - but it is what remix needs to know the subject.
check("the transcription is the words on the graphic",
      api.textFromAlt("May be an image of 2 people, ocean and text that says 'SALE ENDS FRIDAY'"),
      "SALE ENDS FRIDAY");
check("  and the scene is read from the same string",
      api.sceneFromAlt("May be an image of 2 people, ocean and text that says 'SALE ENDS FRIDAY'"),
      "2 people, ocean");

check("a wordless photo still yields a subject",
      api.sceneFromAlt("May be an image of 3 people and outdoors"),
      "3 people and outdoors");
check("  where the transcription is correctly empty",
      api.textFromAlt("May be an image of 3 people and outdoors"), "");

check("a dangling 'and text' is trimmed",
      api.sceneFromAlt("May be an image of one person and text"), "one person");

// The scene reader must stay off anything that is not Facebook's own phrasing.
check("alt a person wrote is not a scene description",
      api.sceneFromAlt("Our new storefront on opening day, finally finished"), "");
check("no description available yields nothing",
      api.sceneFromAlt("No photo description available."), "");
check("an avatar yields nothing", api.sceneFromAlt("Emma Clarke profile picture"), "");
check("an empty alt yields nothing", api.sceneFromAlt(""), "");

console.log();
console.log("a screenshot of another post is not read as the caption");

// OCR of someone else's post carries its chrome — these must be recognised.
check("a reaction tally in the OCR is post chrome",
      api.looksLikePostChrome("Jane Doe\n50K reactions 2.1K comments\nGreat news everyone"), true);
check("the transcribed action bar is post chrome",
      api.looksLikePostChrome("Some text\nLike Comment Share"), true);

console.log();
console.log("real meme and quote-card text is still kept");
[
  "When you finally finish the project and it actually works",
  "The best time to plant a tree was 20 years ago. The second best time is now.",
  "SALE ENDS FRIDAY - everything must go",
  "Monday motivation: keep showing up"
].forEach(function (real) {
  check("not post chrome: " + real.slice(0, 34), api.looksLikePostChrome(real), false);
});

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("captions behave");
process.exit(0);
