/* A clamped caption must never be stored.

   Facebook hides long post text behind a "See more" control. Reading
   innerText off a clamped post captured the first fragment and dropped the
   rest, so the copy you'd study — and the copy Sage rewrites from — was
   partial. The scanner now expands and captures on the next pass. */
var src = require("fs").readFileSync(
  require("path").join(__dirname, "..", "extension", "content.js"), "utf8");

global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
// isBelowBar lives further up the file; pull it in too.
eval(src.slice(src.indexOf("  function isBelowBar"), src.indexOf("  // Elements belonging to THIS article")) +
     src.slice(src.indexOf("  var SEE_MORE_RE"), src.indexOf("  function bodyPass")));

function el(opts) {
  var e = Object.assign({
    attrs: {}, innerText: "", textContent: "", kids: [],
    compareDocumentPosition: function () { return 0; },
  }, opts);
  e.getAttribute = function (k) { return e.attrs[k] === undefined ? null : e.attrs[k]; };
  e.closest = function () { return e._article; };
  return e;
}

function build(controls, belowBar) {
  var article = {};
  var nodes = controls.map(function (text, i) {
    var n = el({ textContent: text, attrs: { role: "button" } });
    n._article = article;
    n.compareDocumentPosition = function () {
      return belowBar && belowBar.indexOf(i) !== -1 ? Node.DOCUMENT_POSITION_FOLLOWING : 0;
    };
    return n;
  });
  article.querySelectorAll = function () { return nodes; };
  return { article: article, bar: el({ compareDocumentPosition: function (n) {
    return n && n.compareDocumentPosition ? n.compareDocumentPosition() : 0; } }) };
}

var cases = [
  { name: "finds a See more above the action bar",
    controls: ["Like", "See more", "Share"], below: [], expect: true },
  { name: "case-insensitive",
    controls: ["see more"], below: [], expect: true },
  { name: "ignores See more that belongs to a comment (below the bar)",
    controls: ["See more"], below: [0], expect: false },
  { name: "ignores 'View more comments'",
    controls: ["View more comments"], below: [], expect: false },
  { name: "ignores 'See less'",
    controls: ["See less"], below: [], expect: false },
  { name: "ignores a caption that merely contains the words",
    controls: ["Click here to see more of our work"], below: [], expect: false },
  { name: "nothing to expand",
    controls: ["Like", "Comment", "Share"], below: [], expect: false },
];

var failures = 0;
cases.forEach(function (c) {
  var b = build(c.controls, c.below);
  var got = !!findSeeMore(b.article, b.bar);
  if (got !== c.expect) {
    failures++;
    console.log(" FAIL  " + c.name + "   got " + got + ", want " + c.expect);
  } else {
    console.log("  ok   " + c.name);
  }
});
console.log(failures ? "\n" + failures + " FAILURES"
                     : "\nall " + cases.length + " See-more cases correct");
process.exit(failures ? 1 : 0);
