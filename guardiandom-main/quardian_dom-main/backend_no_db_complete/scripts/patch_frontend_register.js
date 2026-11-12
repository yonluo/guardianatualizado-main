const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'assets', 'index-Cm3xJCrL.js');
let s = fs.readFileSync(file, 'utf8');
let changed = false;

// 1) insert telefone state after [E,L]=se.useState("")
if (s.includes('[E,L]=se.useState(""),[te,qe]=se.useState(""),') === false) {
  s = s.replace('[E,L]=se.useState("") ,', '[E,L]=se.useState("") ,');
  // more reliable insertion using regex
  s = s.replace(/\[E,L\]=se.useState\(\"\"\),/, '[E,L]=se.useState(""),[te,qe]=se.useState(""),');
  changed = true;
}

// 2) include telefone in register payload
if (s.includes('JSON.stringify({name:h,telefone:te,email:M,password:ne})') === false) {
  s = s.replace(
    'JSON.stringify({name:h,email:M,password:ne})',
    'JSON.stringify({name:h,telefone:te,email:M,password:ne})'
  );
  changed = true;
}

// 3) insert telefone input after username input
const usernameBlock =
  'children:[s.jsx("label",{htmlFor:"username",className:"block text-white mb-2",children:"Nome de Usuário"}),s.jsx("input",{id:"username",type:"text",value:E,onChange:$=>L($.target.value)';
if (s.includes('htmlFor:"telefone"') === false && s.indexOf(usernameBlock) !== -1) {
  // find position after the username input closing
  const pos = s.indexOf('id:"username",type:"text",value:E,onChange:$=>L($.target.value)');
  if (pos !== -1) {
    // find the end of that input block (look for 'required:!0})')
    const rest = s.slice(pos);
    const endIdx = rest.indexOf('required:!0})');
    if (endIdx !== -1) {
      const insertPos = pos + endIdx + 'required:!0})'.length;
      const insert =
        ',s.jsxs("div",{children:[s.jsx("label",{htmlFor:"telefone",className:"block text-white mb-2",children:"Telefone"}),s.jsx("input",{id:"telefone",type:"text",value:te,onChange:$=>qe($.target.value),className:"w-full px-4 py-3 bg-white/10 backdrop-blur-sm border-2 border-[#FFD700]/30 rounded-lg text-white placeholder-white/50 focus:border-[#FFD700] focus:outline-none transition-colors",placeholder:"(21) 9xxxx-xxxx",required:!0})]})';
      s = s.slice(0, insertPos) + insert + s.slice(insertPos);
      changed = true;
    }
  }
}

if (!changed) {
  console.log('Nenhuma alteração necessária (pode já estar aplicada)');
  process.exit(0);
}
fs.writeFileSync(file, s, 'utf8');
console.log('Patch aplicado ao bundle do frontend.');
