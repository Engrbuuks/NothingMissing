/** The header matching is what makes a real spreadsheet work or not. */
const HEADER_ALIASES = {
  tag: ['tag','asset tag','asset no','asset number','code','id','asset id'],
  name: ['name','asset','description','item','asset name','particulars'],
  serial: ['serial','serial no','serial number','s/n','sn','serialno'],
  category: ['category','class','group','asset class'],
  type: ['type','sub category','subcategory','sub-category','kind'],
  brand: ['brand','make','manufacturer'],
  model: ['model','model no','model number','model name'],
  holder: ['holder','assigned to','user','custodian','assignee','department','room'],
  acquired: ['acquired','acquired on','purchase date','date purchased','date'],
  cost: ['cost','purchase cost','value','amount','price'],
  units: ['units','unit','qty','quantity','number','no of units','count','pieces','nos'],
  location: ['location','site','branch','where','office','depot','store','place'],
};
/** Inventory files use some of the same words for different things: "Code" is
 *  an asset tag on a register and a SKU on a stock list. */
const STOCK_ALIASES = {
  sku: ['sku','code','item code','part no','part number','stock code','ref'],
  name: ['name','item','description','particulars','item name','product','material'],
  category: ['category','class','group','type'],
  unit: ['unit','uom','unit of measure','units','measure'],
  qty: ['qty','quantity','opening','opening balance','balance','stock','on hand','count'],
  reorder: ['reorder','reorder point','reorder level','min','minimum','min level'],
  cost: ['cost','unit cost','price','unit price','value','rate'],
};
function canonical(raw, kind='assets'){
  const h = raw.toLowerCase().replace(/[_.]/g,' ').replace(/\s+/g,' ').trim();
  const map = kind === 'stock' ? STOCK_ALIASES : HEADER_ALIASES;
  for (const [k,a] of Object.entries(map)) if (a.includes(h)) return k;
  return null;
}
function splitLine(line){
  const out=[]; let cur='', q=false;
  for(let i=0;i<line.length;i++){const c=line[i];
    if(c==='"'){ if(q&&line[i+1]==='"'){cur+='"';i++;} else q=!q; }
    else if((c===','||c==='\t')&&!q){ out.push(cur); cur=''; }
    else cur+=c;}
  out.push(cur); return out.map(s=>s.trim());
}

const headerCases = [
  ['S/N','serial'], ['Serial No.','serial'], ['SERIAL NUMBER','serial'],
  ['Asset Tag','tag'], ['Asset_No','tag'], ['  Description  ','name'],
  ['Make','brand'], ['Manufacturer','brand'], ['Model No','model'],
  ['Assigned To','holder'], ['Department','holder'], ['Purchase Cost','cost'],
  ['Date Purchased','acquired'], ['Nonsense Column',null],
  ['Units','units'], ['Qty','units'], ['Quantity','units'], ['No of Units','units'],
  ['Pieces','units'],
  ['Location','location'], ['Site','location'], ['Branch','location'], ['Store','location'],
];
let bad=0;
for(const [input,want] of headerCases){
  const got=canonical(input);
  if(got!==want){console.log(`  FAIL "${input}" -> ${got}, wanted ${want}`); bad++;}
  else console.log(`  ✓ "${input}" -> ${got}`);
}

console.log('\n  quoted fields:');
const line = 'NM-1,"Dell Latitude, 15 inch","SN,001",Lagos';
const cells = splitLine(line);
if(cells.length!==4){console.log('  FAIL split gave',cells.length,'cells:',cells); bad++;}
else console.log('  ✓ commas inside quotes survive:', JSON.stringify(cells));

const tabbed = splitLine('NM-1\tLenovo AIO\tSN-1');
if(tabbed.length!==3){console.log('  FAIL tab-separated'); bad++;}
else console.log('  ✓ tab-separated (pasted from Excel) works');

console.log('\n  inventory headers:');
const stockCases = [
  ['SKU','sku'], ['Item Code','sku'], ['Part No.','sku'], ['Code','sku'],
  ['Item','name'], ['Description','name'], ['Material','name'],
  ['Qty','qty'], ['Quantity','qty'], ['On Hand','qty'], ['Opening Balance','qty'],
  ['Unit','unit'], ['UOM','unit'], ['Unit of Measure','unit'],
  ['Reorder Level','reorder'], ['Min Level','reorder'],
  ['Unit Cost','cost'], ['Rate','cost'],
  ['Nonsense Column',null],
];
for(const [input,want] of stockCases){
  const got=canonical(input,'stock');
  if(got!==want){console.log(`  FAIL "${input}" -> ${got}, wanted ${want}`); bad++;}
  else console.log(`  ✓ "${input}" -> ${got}`);
}

// "Code" has to mean different things on the two kinds of file. If it ever
// resolved the same way for both, one of the two imports is reading the wrong
// column and nothing else would say so.
if(canonical('Code','assets')!=='tag' || canonical('Code','stock')!=='sku'){
  console.log('  FAIL "Code" must be a tag on an asset file and a SKU on a stock file'); bad++;
} else console.log('  ✓ "Code" means tag for assets and sku for stock');

// ---- the maps above are a copy; prove they still match the real parser ----
// A test carrying its own duplicate of the thing it tests passes happily while
// the source drifts underneath it.
import { readFileSync } from 'node:fs';
const src = readFileSync('src/lib/sheet.ts','utf8');
for (const [label, local] of [['HEADER_ALIASES',HEADER_ALIASES],['STOCK_ALIASES',STOCK_ALIASES]]) {
  const m = src.match(new RegExp(`const ${label}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  if(!m){ console.log(`  FAIL could not find ${label} in src/lib/sheet.ts`); bad++; continue; }
  const real = {};
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s*([a-z]+):\s*\[(.*)\],?\s*$/);
    if(km) real[km[1]] = [...km[2].matchAll(/'([^']*)'/g)].map(x=>x[1]);
  }
  const a = JSON.stringify(local), b = JSON.stringify(real);
  if(a!==b){ console.log(`  FAIL ${label} here no longer matches src/lib/sheet.ts`); bad++; }
  else console.log(`  ✓ ${label} matches the real parser`);
}

console.log(bad?`\n✗ ${bad} failures`:'\n✓ sheet parsing correct');
process.exit(bad?1:0);
