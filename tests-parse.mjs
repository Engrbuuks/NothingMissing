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
};
function canonical(raw){
  const h = raw.toLowerCase().replace(/[_.]/g,' ').replace(/\s+/g,' ').trim();
  for (const [k,a] of Object.entries(HEADER_ALIASES)) if (a.includes(h)) return k;
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

console.log(bad?`\n✗ ${bad} failures`:'\n✓ sheet parsing correct');
process.exit(bad?1:0);
