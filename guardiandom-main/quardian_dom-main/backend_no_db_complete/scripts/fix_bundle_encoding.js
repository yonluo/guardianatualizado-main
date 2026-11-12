const fs = require('fs');
const p = 'public/assets/index-Cm3xJCrL.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

const map = {
  'Ã¡': 'á',
  'Ã©': 'é',
  'Ã­': 'í',
  'Ã³': 'ó',
  Ãº: 'ú',
  'Ã£': 'ã',
  Ãµ: 'õ',
  Ãª: 'ê',
  'Ã§': 'ç',
  'Ã‰': 'É',
  Ãš: 'Ú',
  'Ã“': 'Ó',
  ÃÕ: 'Õ',
  'Ã€': 'À',
  'Â´': '´',
  'Ã‚': 'Â',
  Ã: 'í', // fallback (rare)
};

for (const k of Object.keys(map)) {
  if (s.includes(k)) {
    s = s.split(k).join(map[k]);
    changed = true;
    console.log(`Replaced ${k} -> ${map[k]}`);
  }
}

// fix common sequences
const seqMap = {
  'NÃ£o': 'Não',
  'nÃ£o': 'não',
  'JÃ¡': 'Já',
  'jÃ¡': 'já',
  'hÃ¡': 'há',
  'PraÃ§a': 'Praça',
  'praÃ§a': 'praça',
  Ãšltimas: 'Últimas',
  'Ã§Ã£o': 'ção',
  'í ': 'à',
  'Ã­': 'í',
};
for (const k of Object.keys(seqMap)) {
  if (s.includes(k)) {
    s = s.split(k).join(seqMap[k]);
    changed = true;
    console.log(`Replaced seq ${k} -> ${seqMap[k]}`);
  }
}

if (changed) fs.writeFileSync(p, s, 'utf8');
console.log('Encoding fix complete, changed=', changed);
