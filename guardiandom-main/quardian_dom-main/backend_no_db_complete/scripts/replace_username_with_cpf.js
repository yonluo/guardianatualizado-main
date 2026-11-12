const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'assets');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

const replacements = [
  { from: /Nome de Usuário/g, to: 'CPF' },
  { from: /htmlFor:\\"username\\"/g, to: 'htmlFor:"cpf"' },
  { from: /id:\\"username\\"/g, to: 'id:"cpf"' },
  { from: /placeholder:\\"@usuario\\"/g, to: 'placeholder:"000.000.000-00"' },
  { from: /@usuario/g, to: '000.000.000-00' },
  { from: /\busername\b/g, to: 'cpf' },
];

let totalChanged = 0;
for (const f of files) {
  const p = path.join(dir, f);
  let s = fs.readFileSync(p, 'utf8');
  let changed = false;
  for (const r of replacements) {
    if (r.from.test(s)) {
      s = s.replace(r.from, r.to);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(p, s, 'utf8');
    console.log(`Replaced username -> cpf in ${f}`);
    totalChanged++;
  }
}
if (totalChanged === 0) console.log('No replacements needed');
