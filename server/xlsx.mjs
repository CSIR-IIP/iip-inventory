import { deflateRawSync } from 'node:zlib';

const xesc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function col(n) { let s = ''; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
function sheet(rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => typeof v === 'number' ? `<c r="${col(ci + 1)}${ri + 1}" t="n"><v>${v}</v></c>` : `<c r="${col(ci + 1)}${ri + 1}" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${col(Math.max(...rows.map(r => r.length)))}${rows.length}"/></worksheet>`;
}
function createZip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); return c >>> 0; });
  const crc32 = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const fn = Buffer.from(name), raw = Buffer.from(content), compressed = deflateRawSync(raw), crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(compressed.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(fn.length, 26); h.writeUInt16LE(0, 28);
    locals.push(h, fn, compressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(fn.length, 28);
    c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    centrals.push(c, fn); offset += h.length + fn.length + compressed.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, end]);
}

const issued = i => Object.values(i.alloc || {}).reduce((a, b) => a + b, 0);
const ACTIVITY = { in: 'Stock in', out: 'Issued to location', return: 'Returned to central', edit: 'Edited', delete: 'Deleted', consume: 'Consumed at location', damage: 'Damaged at location', missing: 'Missing at location' };

/** Same four worksheets and columns as the original export. */
export function buildWorkbook(state) {
  const entries = [], put = (p, s) => entries.push([p, s]);
  const sheets = [
    { name: 'Inventory', rows: [['Item', 'Category', 'Central stock', 'Unit', 'Assigned units', 'Total units', 'Minimum stock', 'Status', 'Description', 'Sample'], ...state.items.map(i => [i.name, i.category, i.qty, i.unit, issued(i), i.qty + issued(i), i.min, i.qty === 0 ? 'Out of stock' : i.qty <= i.min ? 'Low stock' : 'In stock', i.description || '', i.sample ? 'Yes' : 'No'])] },
    { name: 'Location allocations', rows: [['Location', 'Item', 'Category', 'Quantity', 'Unit'], ...state.items.flatMap(i => Object.entries(i.alloc || {}).filter(([, q]) => q > 0).map(([l, q]) => [l, i.name, i.category, q, i.unit]))] },
    { name: 'Activity log', rows: [['Date', 'Activity', 'Item', 'Quantity', 'Location', 'Note'], ...state.log.slice().sort((a, b) => b.ts - a.ts).map(e => [e.date, ACTIVITY[e.type] || e.type, e.item, e.qty, e.loc || '', e.note || ''])] },
    { name: 'Locations', rows: [['Location group', 'Location', 'Total units', 'Distinct items'], ...state.groups.flatMap(([g, ls]) => ls.map(l => [g, l, state.items.reduce((a, i) => a + ((i.alloc || {})[l] || 0), 0), state.items.filter(i => ((i.alloc || {})[l] || 0) > 0).length]))] }
  ];
  put('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  put('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  put('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheet(s.rows)));
  return createZip(entries);
}
