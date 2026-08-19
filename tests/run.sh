#!/bin/sh
# Every test, one command. Run before pushing.
set -e
cd "$(dirname "$0")/.."

echo "--- syntax ---"
for f in extension/*.js static/js/*.js; do node --check "$f"; done
python -c "import ast,glob;[ast.parse(open(f,encoding='utf-8').read()) for f in glob.glob('*.py')];print('python ok')"
python -c "
import jinja2, pathlib
env = jinja2.Environment(loader=jinja2.FileSystemLoader('templates'))
for p in pathlib.Path('templates').glob('*.html'):
    env.parse(p.read_text(encoding='utf-8'), filename=p.name)
print('templates ok')"
python -c "import json;json.load(open('extension/manifest.json',encoding='utf-8'));print('manifest ok')"

echo "--- no duplicate definitions ---"
# A duplicated block once meant edits landed in code the browser never ran.
node -e '
var src = require("fs").readFileSync("extension/content.js", "utf8").split("\n");
var seen = {}, dupes = [];
src.forEach(function (l, i) {
  var m = l.match(/^\s*(?:function (\w+)|var ([A-Z_]+) =)/);
  if (!m) return;
  var n = m[1] || m[2];
  if (seen[n]) dupes.push(n + " (lines " + seen[n] + ", " + (i + 1) + ")");
  else seen[n] = i + 1;
});
if (dupes.length) { console.error("DUPLICATE DEFINITIONS: " + dupes.join(", ")); process.exit(1); }
console.log("content.js clean");
'

echo "--- scan captures posts ---"
node tests/scan.test.js
echo "--- extraction ---"
node tests/extract.test.js
echo "--- captions ---"
node tests/caption.test.js
echo "--- timestamps ---"
node tests/timestamp.test.js
echo "--- capture delivery ---"
node tests/delivery.test.js
echo "--- service worker ---"
node tests/worker.test.js
echo "--- self-update ---"
node tests/updater.test.js
echo "--- scoring accuracy rules ---"
python tests/scoring.test.py
echo "--- accounts, keys and sessions ---"
python tests/auth.test.py
echo "--- entitlement ---"
python tests/billing.test.py
echo "--- cross-user health ---"
python tests/users.test.py
echo "--- capture health canary ---"
python tests/health.test.py
echo "--- app consistency ---"
python tests/consistency.test.py
