const fs = require('fs');
const p = 'public/assets/index-Cm3xJCrL.js';
let s = fs.readFileSync(p, 'utf8');
const marker = 'function Ff(';
const idx = s.indexOf(marker);
if (idx === -1) {
  console.error('function Ff not found');
  process.exit(1);
}
const slice = s.slice(idx, idx + 800); // read the next chunk
// find the first occurrence of 'se.useState' sequence and insert after second one
const constStart = slice.indexOf('const');
if (constStart === -1) {
  console.error('const not found after Ff');
  process.exit(1);
}
const constBlock = slice.slice(constStart, slice.indexOf('Le=$', constStart));
// if te already present, exit
if (constBlock.includes('[te,qe]=se.useState')) {
  console.log('te already present in Ff');
  process.exit(0);
}
// replace the first occurrence of 'se.useState(""),' after [E,L]
let newConstBlock = constBlock.replace(
  /(\[E,L\]=se.useState\(\"\"\),)/,
  '$1[te,qe]=se.useState(""),'
);
if (newConstBlock === constBlock) {
  // fallback: insert after the second se.useState occurrence
  const parts = constBlock.split('se.useState(""),');
  if (parts.length >= 2) {
    newConstBlock =
      parts[0] +
      'se.useState(""),[te,qe]=se.useState(""),' +
      parts.slice(1).join('se.useState(""),');
  } else {
    console.error('Could not insert te state');
    process.exit(1);
  }
}
// write back
const before = s.slice(0, idx + constStart);
const after = s.slice(idx + constStart + constBlock.length);
const newS = before + newConstBlock + after;
fs.writeFileSync(p, newS, 'utf8');
console.log('Inserted te state into Ff');
