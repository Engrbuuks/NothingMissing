/**
 * Blank CSV templates, with the headers already correct and two example rows
 * showing the shape.
 *
 * Worth a route rather than a static file for one reason: these headers and the
 * ones the parser accepts are the same fact, so putting the template next to
 * the importer makes it obvious they have to be changed together. A template
 * offering a column the parser ignores is worse than no template.
 *
 * The example rows are deliberately left in. A template with headers and no
 * rows leaves somebody guessing whether a date is 2026-03-14 or 14/03/2026,
 * and whether a cost carries a currency symbol.
 */
export const dynamic = 'force-dynamic';

const ASSETS = `Name,Units,Serial No.,Category,Type,Make,Model,Assigned To,Purchase Cost,Date Purchased
Lenovo ThinkCentre M90a,1,SN-4471,IT equipment,Desktop computer,Lenovo,ThinkCentre M90a,Gabriel,480000,2026-02-11
Lenovo ThinkCentre M90a,1,SN-4472,IT equipment,Desktop computer,Lenovo,ThinkCentre M90a,Accounts,480000,2026-02-11
Task chair mesh back,50,,Furniture,Seating,Ergo,Mesh Task,,42000,
Meeting table 6 seater,8,,Furniture,Tables,Ergo,Oak 6S,,185000,
Perkins 100 kVA generator,1,PK-99823,Power,Generator,Perkins,1104A-44TG2,Facilities,8450000,2025-11-03
Standing fan,12,,,,,,,,
`;

const STOCK = `Item,SKU,Category,Unit,Quantity,Reorder Level,Unit Cost
Diesel,DSL-001,Fuel,litres,3000,500,1250
Engine oil 20W50,OIL-20W50,Consumables,litres,180,40,4800
Air filter,FLT-AIR-01,Spares,units,24,6,8500
Safety helmet,PPE-HLM-01,Safety,units,40,10,6500
Masking tape,,,,,,
Cable ties,,Consumables,units,250,,
`;

export function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind') === 'stock' ? 'stock' : 'assets';
  const body = kind === 'stock' ? STOCK : ASSETS;
  const file = kind === 'stock' ? 'inventory-template.csv' : 'assets-template.csv';

  // The byte order mark is what makes Excel open a UTF-8 CSV without mangling
  // accented characters. The importer strips it again on the way back in.
  return new Response('﻿' + body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'no-store',
    },
  });
}
