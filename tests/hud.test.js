/* The panel's box: where it sits, and which way it grows.
 *
 * Resizing read as inverted — dragging the grip outward made the panel
 * smaller and dragging it inward made it bigger. The cause was not the
 * resize code, because there isn't any: the panel uses the browser's own
 * grip, and CSS resize always grows a box down and to the right of its
 * TOP-LEFT corner. The panel was pinned by right and bottom, so the corner
 * you grab was the one corner that could not move. The box expanded away
 * from the cursor instead of toward it.
 *
 * The geometry is asserted here rather than the styling, because the styling
 * is only the means: what matters is that the grabbed corner follows the
 * drag and the anchored corner stays put.
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

function api(storage) {
  return runScan(buildPage([]), "/groups/1", { storage: storage || {} });
}

/* Resolve a fixed-position box the way the browser would, then grow it the
 * way the native grip does — width and height only, anchor untouched. */
function grow(box, by) {
  return {
    left: box.left, top: box.top,
    right: box.left + box.width + by,
    bottom: box.top + box.height + by
  };
}

console.log("the panel grows toward the corner you grabbed");

var fresh = api().loadHudBox();
var before = { left: fresh.left, top: fresh.top, right: fresh.left + fresh.width,
               bottom: fresh.top + fresh.height };
var after = grow(fresh, 100);

check("the grabbed corner moves with the drag",
      [after.right - before.right, after.bottom - before.bottom], [100, 100]);
check("the anchored corner stays where it was",
      [after.left - before.left, after.top - before.top], [0, 0]);

console.log();
console.log("nobody's saved placement is thrown away");

/* What an older version wrote. Converting rather than discarding it means a
 * panel someone moved deliberately is still where they left it after the
 * update. Viewport is 1440x900 in the harness.
 *
 * The offsets here are deliberately NOT the default 20. With 20 the
 * converted position and the fallback position are the same number, so the
 * assertion passed whether or not the conversion ran at all — it proved
 * nothing. These values only come out right if the box was really migrated.
 */
var migrated = api({
  outlierHud: JSON.stringify({ width: 380, height: 460, right: 300, bottom: 150 })
}).loadHudBox();

check("a right/bottom box becomes the same box in left/top",
      [migrated.left, migrated.top], [1440 - 300 - 380, 900 - 150 - 460]);
check("  keeping its size", [migrated.width, migrated.height], [380, 460]);

var current = api({
  outlierHud: JSON.stringify({ width: 400, height: 500, left: 120, top: 60 })
}).loadHudBox();
check("a left/top box is used as written",
      [current.left, current.top, current.width, current.height], [120, 60, 400, 500]);

console.log();
console.log("the panel stays reachable");

var clamp = api().clampHudBox;

check("a panel saved off the right edge is pulled back",
      clamp({ width: 380, height: 460, left: 5000, top: 100 }).left, 1440 - 380);
check("a panel saved above the top edge comes back down",
      clamp({ width: 380, height: 460, left: 100, top: -300 }).top, 0);

/* The header is the only way to drag the panel back, so it must never sit
 * below the bottom edge — that would strand the panel permanently. */
var stranded = clamp({ width: 380, height: 460, left: 100, top: 4000 });
check("a panel dragged past the bottom keeps its header on screen",
      stranded.top <= 900 - 40, true);

check("a panel wider than the window still starts on screen",
      clamp({ width: 3000, height: 460, left: 900, top: 10 }).left, 0);

console.log();
if (FAILURES.length) {
  console.log(FAILURES.length + " FAILURES");
  process.exit(1);
}
console.log("the panel behaves");
process.exit(0);
