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
echo "--- engagement extraction ---"
node tests/engagement.test.js
echo "--- see more expansion ---"
node tests/seemore.test.js
echo "--- source detection ---"
node tests/surfaces.test.js
echo "--- app consistency ---"
python tests/consistency.test.py
