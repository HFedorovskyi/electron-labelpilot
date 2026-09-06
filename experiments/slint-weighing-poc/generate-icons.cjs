const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const icons = require('lucide-react');
const names = ['Scale','Weight','ClipboardList','ListRestart','Stethoscope','Package','KeyRound','Settings','LogOut','Printer','RefreshCw','Box','Trash2','Layers','Search','Hash','Calendar','ChevronLeft','Menu','User','UserCog','X','AlertCircle','CheckCircle2'];
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const out = path.resolve('experiments/slint-weighing-poc/assets/icons');
for (const name of names) {
  const Icon = icons[name];
  if (!Icon) throw new Error(`Missing lucide icon ${name}`);
  const svg = renderToStaticMarkup(React.createElement(Icon, {
    xmlns: 'http://www.w3.org/2000/svg', width: 24, height: 24,
    color: '#000000', strokeWidth: 2, absoluteStrokeWidth: true
  }));
  fs.writeFileSync(path.join(out, `${kebab(name)}.svg`), `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
}
console.log(`GENERATED=${names.length}`);
