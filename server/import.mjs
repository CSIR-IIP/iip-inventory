import {inflateRawSync} from 'node:zlib';

const MAX_ROWS=1000,MAX_XML=20e6;
const unesc=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&amp;/g,'&');

function unzip(buf){
  let e=buf.length-22;while(e>=0&&buf.readUInt32LE(e)!==0x06054b50)e--;
  if(e<0)throw new Error('This file is not a valid .xlsx workbook. Save it as Excel Workbook (.xlsx) and try again.');
  const count=buf.readUInt16LE(e+10);let o=buf.readUInt32LE(e+16);const files={};
  for(let i=0;i<count;i++){
    if(buf.readUInt32LE(o)!==0x02014b50)break;
    const method=buf.readUInt16LE(o+10),size=buf.readUInt32LE(o+20),nl=buf.readUInt16LE(o+28),el=buf.readUInt16LE(o+30),cl=buf.readUInt16LE(o+32),lo=buf.readUInt32LE(o+42);
    const name=buf.toString('utf8',o+46,o+46+nl);o+=46+nl+el+cl;
    if(!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name))continue;
    const start=lo+30+buf.readUInt16LE(lo+26)+buf.readUInt16LE(lo+28),data=buf.subarray(start,start+size);
    files[name]=(method===8?inflateRawSync(data,{maxOutputLength:MAX_XML}):data).toString('utf8');
  }
  return files;
}
const colIndex=ref=>{let n=0;for(const ch of ref.replace(/\d/g,''))n=n*26+ch.charCodeAt(0)-64;return n-1};

function readXlsx(buf){
  const f=unzip(buf),sheetName=Object.keys(f).filter(n=>n.includes('worksheets')).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}))[0];
  if(!sheetName)throw new Error('No worksheet found in this workbook.');
  const shared=[...(f['xl/sharedStrings.xml']||'').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m=>unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join('')));
  const rows=[];
  for(const r of f[sheetName].matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
    const row=[];
    for(const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const a=c[1],ref=/\br="([A-Z]+\d+)"/.exec(a)?.[1],t=/\bt="(\w+)"/.exec(a)?.[1],inner=c[2]||'';
      if(!ref)continue;
      const v=/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val='';
      if(t==='s')val=shared[+v]??'';
      else if(t==='inlineStr')val=unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join(''));
      else if(v!==undefined)val=t==='str'?unesc(v):(t==='b'?v:Number(v));
      row[colIndex(ref)]=val;
    }
    rows.push(Array.from(row,x=>x??''));
  }
  return rows;
}
function readCsv(text){
  const rows=[];let row=[],cur='',q=false;text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(q){if(ch==='"'&&text[i+1]==='"'){cur+='"';i++}else if(ch==='"')q=false;else cur+=ch}
    else if(ch==='"')q=true;else if(ch===','){row.push(cur);cur=''}
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cur);rows.push(row);row=[];cur=''}
    else cur+=ch}
  if(cur||row.length){row.push(cur);rows.push(row)}
  return rows;
}
export function parseUpload(buf,filename=''){
  if(!buf.length)throw new Error('The selected file is empty.');
  const rows=/\.csv$/i.test(filename)?readCsv(buf.toString('utf8')):readXlsx(buf);
  return rows.filter(r=>r.some(c=>String(c).trim()!==''));
}

const ALIASES={name:['itemname','item','name','itemdetails','product'],qty:['quantity','qty','stockin','received','add','counted','countedquantity','centralstock'],category:['category'],unit:['unit','uom'],min:['minimumstocklevel','minimumstock','minlevel','min','minimum','minqty'],description:['description','details','specification'],date:['date','transactiondate','receiveddate'],note:['note','notes','remarks','reference']};
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
const serialToDate=n=>new Date(Date.UTC(1899,11,30)+Math.round(n)*864e5).toISOString().slice(0,10);

/** Pure validation: never mutates state. Returns ops to apply plus per-row errors. */
export function planImport(rows,state,CATS,mode,today,filename=''){
  const errors=[],ops=[];
  if(rows.length<2)return {errors:[{row:1,message:'Add a header row and at least one item row.'}],ops,columns:[]};
  if(rows.length-1>MAX_ROWS)return {errors:[{row:1,message:`Import up to ${MAX_ROWS} rows at a time. Split this file and try again.`}],ops,columns:[]};
  const head=rows[0].map(norm),idx={};
  for(const [k,names] of Object.entries(ALIASES)){const i=head.findIndex(h=>names.includes(h));if(i>=0)idx[k]=i}
  for(const need of ['name','qty'])if(idx[need]===undefined)return {errors:[{row:1,message:`Add a "${need==='name'?'Item name':'Quantity'}" column to the header row.`}],ops,columns:[]};
  const sim=new Map(state.items.map(i=>[i.name.toLowerCase(),{qty:i.qty,unit:i.unit,exists:true}]));
  rows.slice(1).forEach((r,n)=>{
    const row=n+2,g=k=>idx[k]===undefined?'':r[idx[k]]??'',name=String(g('name')).trim(),err=m=>errors.push({row,message:m});
    if(!name)return err('Enter an item name.');
    const qty=Number(g('qty')),min=g('min')===''?undefined:Number(g('min'));
    if(g('qty')===''||!Number.isInteger(qty)||qty<(mode==='set'?0:1))return err(`${name}: use a whole quantity of ${mode==='set'?'0':'1'} or more.`);
    if(min!==undefined&&(!Number.isInteger(min)||min<0))return err(`${name}: minimum level must be a whole number, 0 or more.`);
    let date=g('date');if(typeof date==='number')date=serialToDate(date);date=String(date).trim()||today;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today)return err(`${name}: use a date like 2026-11-12 that is not in the future.`);
    const key=name.toLowerCase(),cur=sim.get(key),note=String(g('note')).trim().slice(0,140)||`Imported from ${filename||'spreadsheet'}`;
    let category=String(g('category')).trim();category=CATS.find(c=>c.toLowerCase()===category.toLowerCase())||category;
    if(!cur){
      if(!CATS.includes(category))return err(`${name} is new: set Category to one of ${CATS.join(', ')}.`);
      sim.set(key,{qty,unit:String(g('unit')).trim()||'pcs',exists:true});
      return ops.push({row,action:'create',name,category,unit:String(g('unit')).trim()||'pcs',min:min??5,description:String(g('description')).trim().slice(0,200),qty,before:0,after:qty,date,note});
    }
    const before=cur.qty,after=mode==='set'?qty:before+qty;cur.qty=after;
    ops.push({row,action:mode==='set'?'set':'add',name,qty,before,after,date,note,unit:cur.unit});
  });
  return {errors,ops,columns:Object.keys(idx)};
}
