/* Reproduces the reported bug: a post whose caption contains a large number
   was stored with that number as its reaction count. */
var src = require("fs").readFileSync(
  require("path").join(__dirname, "..", "extension", "content.js"), "utf8");

// Lift the pure extraction pieces out of the IIFE.
// One contiguous block: parseCount through extractEngagement. Everything in
// it is a declaration, so pulling it wholesale is safe.
var code = src.slice(src.indexOf("var MAX_PLAUSIBLE_COUNT"),
                     src.indexOf("  /* Visual content."));
global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
eval(code);

// --- tiny DOM ------------------------------------------------------------
function el(opts) {
  var e = Object.assign({
    attrs: {}, kids: [], innerText: "", parentElement: null,
    previousElementSibling: null, _article: null,
    // Nothing in these fixtures sits below the action bar; the below-bar
    // split has its own coverage elsewhere.
    compareDocumentPosition: function () { return 0; },
  }, opts);
  e.getAttribute = function (k) { return e.attrs[k] === undefined ? null : e.attrs[k]; };
  e.closest = function () { return e._article; };
  return e;
}

function buildArticle(spec) {
  var article = {};
  var labelled = (spec.labels || []).map(function (l) {
    var e = el({ attrs: { "aria-label": l } }); e._article = article; return e;
  });

  // Rows above the action bar, as real dir="auto" blocks -- what Facebook
  // actually renders, and what engagementChrome now reads.
  var rows = (spec.rows || []).map(function (text) {
    var e = el({ innerText: text, attrs: { dir: "auto" }, tag: "DIV" });
    e._article = article;
    return e;
  });
  for (var i = 1; i < rows.length; i++) rows[i].previousElementSibling = rows[i - 1];

  // The caption is whichever row the body extractor would have picked: the
  // longest one. Passed to extractEngagement so it can be excluded.
  var caption = null;
  rows.forEach(function (r) {
    if (!caption || r.innerText.length > caption.innerText.length) caption = r;
  });
  if (spec.captionIndex !== undefined) caption = rows[spec.captionIndex];
  if (spec.noCaption) caption = null;

  var barParent = el({ innerText: "" });
  barParent.previousElementSibling = rows.length ? rows[rows.length - 1] : null;
  var bar = el({ innerText: "Like Comment Share" });
  bar.parentElement = barParent;
  bar._article = article;

  article.querySelectorAll = function (sel) {
    if (sel === "[aria-label]") return labelled;
    if (/span|dir="auto"|role="button"/.test(sel)) return rows;
    return [];
  };
  return { article: article, bar: bar, caption: caption };
}

var cases = [
  { name: "THE BUG: caption with a huge number, 4 real reactions",
    labels: ["4 reactions"],
    rows: ["Anthropic says Claude processed 11,000,000 tokens in the benchmark run this week"],
    expect: { likes: 4 } },

  { name: "caption number, NO real count anywhere",
    labels: [],
    rows: ["We processed 11,000,000 tokens and it cost 250,000 dollars"],
    expect: { likes: 0, read: false } },

  { name: "normal post: labelled counts",
    labels: ["312 reactions", "47 comments", "12 shares"],
    rows: [],
    expect: { likes: 312, comments: 47, shares: 12, read: true } },

  { name: "bare summary row above the bar",
    labels: [],
    rows: ["Some caption text that is quite long and mentions 900 things", "1.2K"],
    expect: { likes: 1200 } },

  { name: "summary row with a separator, on a caption-less image post",
    labels: [],
    rows: ["458 · 32"],
    noCaption: true,
    expect: { likes: 458 } },

  { name: "timestamp above the bar is not a count",
    labels: [],
    rows: ["5h"],
    expect: { likes: 0, read: false } },

  { name: "'and 47 others' reaction summary",
    labels: ["Like, Love and 47 others"],
    rows: [],
    expect: { likes: 47 } },

  { name: "image alt-style label must not yield counts",
    labels: ["May be an image of text that says 5,000,000 SUBSCRIBERS"],
    rows: [],
    expect: { likes: 0, read: false } },

  { name: "cross-line: reactions and comments on separate labels",
    labels: ["1.2K reactions", "88 comments", "9 shares"],
    rows: [],
    expect: { likes: 1200, comments: 88, shares: 9, read: true } },

  { name: "video views",
    labels: ["45K views", "300 reactions"],
    rows: [],
    expect: { video_plays: 45000, likes: 300 } },

  { name: "caption mentioning 'shares' as a word",
    labels: [],
    rows: ["I bought 500 shares of the company last year and it doubled"],
    expect: { shares: 0, read: false } },

  { name: "labelled zero is still a read",
    labels: ["0 comments", "3 reactions"],
    rows: [],
    expect: { likes: 3, comments: 0, read: true } },

  { name: "absurd number is rejected by the plausibility cap",
    labels: [String(99000000) + " reactions"],
    rows: [],
    expect: { likes: 0, read: false } },

  { name: "a SHORT caption with a number is not a count",
    labels: [],
    rows: ["Only 3 spots left!"],
    expect: { likes: 0, read: false } },

  { name: "summary row wins even when a caption sits beside it",
    labels: [],
    rows: ["Here is a reasonably long caption about our new product launch", "412"],
    expect: { likes: 412 } },
];

var failures = 0;
cases.forEach(function (c) {
  var built = buildArticle(c);
  var got = extractEngagement(built.article, built.bar, built.caption);
  var bad = Object.keys(c.expect).filter(function (k) { return got[k] !== c.expect[k]; });
  if (bad.length) {
    failures++;
    console.log(" FAIL  " + c.name);
    bad.forEach(function (k) { console.log("        " + k + ": got " + got[k] + ", want " + c.expect[k]); });
  } else {
    console.log("  ok   " + c.name + "  ->  " + got.likes + "r " + got.comments + "c " + got.shares + "s");
  }
});
console.log(failures ? "\n" + failures + " FAILURES" : "\nall " + cases.length + " engagement cases correct");
process.exit(failures ? 1 : 0);
