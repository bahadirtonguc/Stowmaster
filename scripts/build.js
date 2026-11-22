// Builds dist/index.html: inlines src/planner.js and src/drawing.js into src/template.html.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const planner = fs.readFileSync(path.join(root, 'src/planner.js'), 'utf8');
const drawing = fs.readFileSync(path.join(root, 'src/drawing.js'), 'utf8');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'),
  tpl.replace('/*PLANNER*/', () => planner).replace('/*DRAWING*/', () => drawing));
console.log('built dist/index.html');
