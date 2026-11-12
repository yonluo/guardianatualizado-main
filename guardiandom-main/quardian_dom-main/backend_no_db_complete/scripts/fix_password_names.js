const fs = require('fs');
const p = 'public/assets/index-Cm3xJCrL.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

const before1 = 'id:"password",type:"password",value:ne';
const after1 = 'id:"password",name:"password",type:"password",value:ne';
if (s.includes(before1)) {
  s = s.replace(before1, after1);
  changed = true;
}

const before2 = 'id:"confirmPassword",type:"password",value:Z';
const after2 = 'id:"confirmPassword",name:"confirmPassword",type:"password",value:Z';
if (s.includes(before2)) {
  s = s.replace(before2, after2);
  changed = true;
}

// normalize placeholders
s = s.replace(/placeholder:"â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢"/g, 'placeholder:"********"');
if (s.indexOf('placeholder:"********"') !== -1) changed = true;

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('Applied password name fixes');
} else console.log('No changes applied');
