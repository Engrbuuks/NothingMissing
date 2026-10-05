/**
 * The CSV templates we hand people must import.
 *
 * The template and the parser's alias list are the same fact written twice, so
 * they drift: rename a header in the parser and the file somebody downloaded
 * yesterday now has a column that is silently ignored. That is a worse failure
 * than a rejection, because the import succeeds and the data is simply absent.
 *
 * Checks every template column against the real alias map in src/lib/sheet.ts,
 * that each row has the same number of cells as the header, and that the one
 * required column is filled on every row.
 */
import { readFileSync } from 'node:fs';
const route = readFileSync('src/app/import/template/route.ts','utf8');
const sheet = readFileSync('src/lib/sheet.ts','utf8');

function aliases(label){
  const m = sheet.match(new RegExp(`const ${label}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  const out={}; for(const line of m[1].split('\n')){
    const km=line.match(/^\s*([a-z]+):\s*\[(.*)\],?\s*$/);
    if(km) out[km[1]]=[...km[2].matchAll(/'([^']*)'/g)].map(x=>x[1]);
  } return out;
}
const MAPS={assets:aliases('HEADER_ALIASES'), stock:aliases('STOCK_ALIASES')};
const canon=(raw,kind)=>{const h=raw.toLowerCase().replace(/[_.]/g,' ').replace(/\s+/g,' ').trim();
  for(const[k,a]of Object.entries(MAPS[kind]))if(a.includes(h))return k; return null;};

let bad=0;
for (const [label,kind] of [['ASSETS','assets'],['STOCK','stock']]) {
  const m = route.match(new RegExp(`const ${label} = \`([\\s\\S]*?)\`;`));
  if(!m){console.log(`FAIL no ${label} template`); bad++; continue;}
  const lines=m[1].split('\n').filter(l=>l.trim());
  const headers=lines[0].split(',');
  const mapped=headers.map(h=>canon(h,kind));
  const unknown=headers.filter((h,i)=>!mapped[i]);
  console.log(`\n${label}: ${lines.length-1} rows, ${headers.length} columns`);
  headers.forEach((h,i)=>console.log(`  ${mapped[i]?'✓':'✗'} "${h}" -> ${mapped[i]}`));
  if(unknown.length){console.log(`  FAIL our own template has columns the parser ignores: ${unknown.join(', ')}`); bad++;}
  // every row must have the same cell count as the header
  lines.slice(1).forEach((l,i)=>{ const n=l.split(',').length;
    if(n!==headers.length){console.log(`  FAIL row ${i+1} has ${n} cells, header has ${headers.length}`); bad++;}});
  const nameIdx=mapped.indexOf('name');
  lines.slice(1).forEach((l,i)=>{ if(!l.split(',')[nameIdx]?.trim()){console.log(`  FAIL row ${i+1} has no name`); bad++;}});
}
console.log(bad?`\n✗ ${bad} problems`:'\n✓ both templates import cleanly');
process.exit(bad?1:0);
