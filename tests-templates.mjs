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
// ---- blanks must be tolerated ---------------------------------------------
// The import page promises that a row missing most of its cells still imports.
// The templates carry such a row on purpose; this checks it survives parsing
// with its one required column intact, so the promise and the parser cannot
// drift apart.
for (const [label,kind,required] of [['ASSETS','assets','name'],['STOCK','stock','name']]) {
  const m = route.match(new RegExp(`const ${label} = \`([\\s\\S]*?)\`;`));
  const lines = m[1].split('\n').filter(l=>l.trim());
  const mapped = lines[0].split(',').map(h=>canon(h,kind));
  const parsed = lines.slice(1).map(l=>{
    const cells=l.split(','); const row={};
    mapped.forEach((k,i)=>{ if(k && cells[i] && cells[i].trim()) row[k]=cells[i].trim(); });
    return row;
  });
  const sparsest = parsed.reduce((a,b)=>Object.keys(a).length<=Object.keys(b).length?a:b);
  const filled = Object.keys(sparsest).length;
  console.log(`\n${label}: sparsest row keeps ${filled} of ${mapped.filter(Boolean).length} columns`);
  if (!sparsest[required]) { console.log(`  FAIL the sparsest row lost its ${required}`); bad++; }
  else if (filled === mapped.filter(Boolean).length) {
    console.log(`  FAIL every template row is completely filled, so blanks are never exercised`);
    bad++;
  } else console.log(`  ✓ a mostly blank row still carries its ${required}`);
}

console.log(bad?`\n✗ ${bad} problems`:'\n✓ templates import cleanly and tolerate blanks');
process.exit(bad?1:0);
