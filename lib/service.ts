import {visualMatch} from './matching';
import {adapter} from './adapters';
import {env} from 'cloudflare:workers';
import {similarity,nextRun,robotsPolicy} from './intelligence';
const db=()=>env.DB!;const id=()=>crypto.randomUUID();const now=()=>new Date().toISOString();
export const all=async(t:string)=> (await db().prepare(`SELECT * FROM ${t}`).all()).results as any[];
export async function execute(sql:string,...args:any[]){return db().prepare(sql).bind(...args).run()}
export function safeUrl(raw:string){const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)||/^[\d.:\[\]]+$/.test(u.hostname)||/\.(local|internal|localhost)$/.test(u.hostname))throw Error('Use a public HTTPS supplier domain');return u}
async function download(url:string,origin:string){const u=safeUrl(url);if(u.origin!==origin)throw Error('Cross-domain discovery blocked');for(let n=0;n<3;n++){const r=await fetch(u.href,{headers:{'User-Agent':'AnimeCartelBot/1.0 (public product intelligence; conservative crawl)'},redirect:'manual',signal:AbortSignal.timeout(12000)});if([429,503].includes(r.status)&&n<2){await new Promise(r=>setTimeout(r,1500*(n+1)));continue}if(!r.ok)throw Error(`Source returned HTTP ${r.status}`);const text=await r.text();if(text.length>3000000)throw Error('Response exceeds 3 MB limit');return text}throw Error('Retry limit reached')}
async function crawl(s:any,test=false){const config=JSON.parse(s.config);if(!config.termsReviewed)throw Error('Review supplier terms before testing or activating');const base=safeUrl(s.url);const robots=await download(base.origin+'/robots.txt',base.origin);const policy=robotsPolicy(robots);const allowed=policy.allowed;if(!allowed(base.href))throw Error('robots.txt prohibits this source');const urls=new Set<string>([base.href]);const configured=config.productUrls||[];for(const url of configured){const u=new URL(url,base);if(u.origin===base.origin&&allowed(u.href))urls.add(u.href)}
 const products:any[]=[];for(const url of urls){if(urls.size>60||products.length>=2000)break;await new Promise(r=>setTimeout(r,policy.delay*1000));const html=await download(url,base.origin);products.push(...adapter(config.adapter).extract(html,url));if(config.adapter==='woocommerce'){for(const m of html.matchAll(/<a[^>]*class=["'][^"']*next page-numbers[^"']*["'][^>]*href=["']([^"']+)["']/gi)){const u=new URL(m[1],base);if(urls.size<60&&u.origin===base.origin&&allowed(u.href))urls.add(u.href)}}else if(url===base.href){for(const m of html.matchAll(/href=["']([^"']*(?:\/products\/|\/product\/)[^"'#?]*)["']/gi)){const u=new URL(m[1],base);if(urls.size<12&&u.origin===base.origin&&allowed(u.href))urls.add(u.href)}}if(test&&products.length)break}if(!products.length)throw Error('No Product JSON-LD found. Configure product URLs or add an adapter; records were preserved.');return {products:[...new Map(products.filter(p=>{try{return safeUrl(p.url).origin===base.origin}catch{return false}}).map(p=>[p.url,p])).values()],allowed,origin:base.origin}}
export async function createJob(selected:string[]){const jid=id();const active=(await all('suppliers')).filter(s=>s.status==='Active'&&(!selected.length||selected.includes(s.id)));if(!active.length)throw Error('No selected active suppliers');try{await db().batch([db().prepare("INSERT INTO settings(key,value) VALUES('run_lock',?)").bind(jid),db().prepare('INSERT INTO jobs(id,started,status,logs) VALUES(?,?,?,?)').bind(jid,now(),'Running','[]')])}catch{throw Error('A scraping run is already active. Inspect scraping history before retrying.')}return jid}
export async function runJob(jid:string,selected:string[]){
 const sources=(await all('suppliers')).filter(s=>s.status==='Active'&&(!selected.length||selected.includes(s.id)));
 const logs:any[]=[];
 try{
  for(let index=0;index<sources.length;index++){
   const source=sources[index];
   try{
    const {products:found,allowed,origin}=await crawl(source);
    const existing=await all('listings');
    const byUrl=new Map(existing.map(l=>[l.url,l]));
    const candidates=existing.filter(l=>l.supplier_id!==source.id);
    let added=0,updated=0;
    const changes:D1PreparedStatement[][]=[];
    for(const product of found){
     const at=now(),old=byUrl.get(product.url);
     const operations:D1PreparedStatement[]=[];
     const q=(sql:string,...args:any[])=>operations.push(db().prepare(sql).bind(...args));
     if(old){
      q('INSERT INTO history VALUES(?,?,?,?,?,?)',id(),old.id,at,'SNAPSHOT',old.raw,product.raw);
      if(old.price!==product.price){q('INSERT INTO history VALUES(?,?,?,?,?,?)',id(),old.id,at,'PRICE UPDATED',old.raw,product.raw);updated++}
      if(old.stock!==product.stock)q('INSERT INTO history VALUES(?,?,?,?,?,?)',id(),old.id,at,product.stock==='Out of stock'?'OUT OF STOCK':'STOCK UPDATED',old.raw,product.raw);
      q('UPDATE listings SET name=?,image=?,height=?,material=?,price=?,currency=?,stock=?,status=?,raw=?,scraped=? WHERE id=?',product.name,product.image,product.height,product.material,product.price,product.currency,product.stock,old.price!==product.price?'PRICE UPDATED':product.stock==='Out of stock'?'OUT OF STOCK':'Current',product.raw,at,old.id);
     }else{
      const groupId=id(),listingId=id();
      q('INSERT INTO groups VALUES(?,?,?,?)',groupId,product.name,'Unmatched',at);
      q('INSERT INTO listings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',listingId,source.id,groupId,product.url,product.name,product.image,product.height,product.material,product.price,product.currency,product.stock,'NEW',product.raw,at,at);
      q('INSERT INTO history VALUES(?,?,?,?,?,?)',id(),listingId,at,'NEW',null,product.raw);
      added++;
      const ranked=candidates.map(other=>({other,score:similarity(product,other)})).filter(x=>x.score>=.55).sort((a,b)=>b.score-a.score);
      if(ranked.length){const {other,score}=ranked[0];let vision=null;try{vision=await visualMatch(product,other,env)}catch(e:any){logs.push({supplier:source.name,status:'Warning',message:e.message})}
       q('INSERT INTO reviews VALUES(?,?,?,?,?,?,?)',id(),listingId,other.group_id,vision?.confidence??score,vision?.reason??'Text, variant, height and material comparison. Visual identity requires manual verification.','Pending');
      }
     }
     changes.push(operations);
    }
    // Each small batch is transactional; a listing, its group and original
    // history are always committed together. Cache lookups avoid N+1 reads.
    for(let offset=0;offset<changes.length;offset+=20){
     await db().batch(changes.slice(offset,offset+20).flat());
     const processed=Math.min(offset+20,changes.length);
     await execute('UPDATE jobs SET progress=?,logs=? WHERE id=?',Math.min(99,Math.round((index+processed/Math.max(changes.length,1))/sources.length*100)),JSON.stringify([...logs,{supplier:source.name,status:'Running',discovered:found.length,processed,added,updated}]),jid);
    }
    let removed=0;const seen=new Set(found.map(p=>p.url));
    const missing=existing.filter(l=>l.supplier_id===source.id&&!seen.has(l.url)&&l.status!=='REMOVED').slice(0,5);
    for(const old of missing){if(!allowed(old.url))continue;try{
     const u=safeUrl(old.url);if(u.origin!==origin)continue;await new Promise(r=>setTimeout(r,1000));
     const response=await fetch(u.href,{method:'HEAD',redirect:'manual',headers:{'User-Agent':'AnimeCartelBot/1.0'},signal:AbortSignal.timeout(8000)});
     if(response.status===404||response.status===410){await db().batch([db().prepare("UPDATE listings SET status='REMOVED',scraped=? WHERE id=?").bind(now(),old.id),db().prepare('INSERT INTO history VALUES(?,?,?,?,?,?)').bind(id(),old.id,now(),'REMOVED',old.raw,JSON.stringify({httpStatus:response.status,verifiedUrl:old.url}))]);removed++}
    }catch{/* Verification failures preserve prior state. */}}
    await execute('UPDATE suppliers SET last_success=? WHERE id=?',now(),source.id);
    logs.push({supplier:source.name,status:'Success',discovered:found.length,added,updated,removed,at:now()});
   }catch(e:any){logs.push({supplier:source.name,status:'Failed',message:e.message,at:now()})}
   await execute('UPDATE jobs SET progress=?,logs=? WHERE id=?',Math.round((index+1)/sources.length*100),JSON.stringify(logs),jid);
  }
  await execute('UPDATE jobs SET status=?,finished=?,progress=100,logs=? WHERE id=?',logs.some(x=>x.status==='Failed')?'Completed with errors':'Completed',now(),JSON.stringify(logs),jid);
 }catch(e:any){await execute('UPDATE jobs SET status=?,finished=?,logs=? WHERE id=?','Failed',now(),JSON.stringify([...logs,{message:e.message}]),jid)}
 finally{await execute("DELETE FROM settings WHERE key='run_lock' AND value=?",jid)}
}
export async function api(request:Request,path:string[]){const method=request.method;const body=method==='GET'?{}:await request.json() as any;
 if(method==='GET'&&path[0]==='state'){const entries=await all('settings');return Response.json({capabilities:{vision:!!env.MATCHING_API_URL&&!!env.MATCHING_API_TOKEN},suppliers:await all('suppliers'),groups:await all('groups'),listings:await all('listings'),jobs:await all('jobs'),reviews:await all('reviews'),history:await all('history'),audit:await all('audit'),settings:Object.fromEntries(entries.filter(x=>x.key!=='run_lock').map(x=>[x.key,x.value])),nextRun:nextRun(entries.find(x=>x.key==='time')?.value)})}
 if(path[0]==='suppliers'){if(method==='POST'){safeUrl(body.url);if(!body.name?.trim())throw Error('Supplier name is required');const sid=body.id||id();await execute('INSERT INTO suppliers(id,name,url,category,status,config) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,category=excluded.category,status=excluded.status,config=excluded.config',sid,body.name,body.url,body.category||'Indian wholesaler','Paused',JSON.stringify({termsReviewed:!!body.termsReviewed,productUrls:body.productUrls||[],adapter:body.adapter||'jsonld'}));return Response.json({id:sid})}if(method==='DELETE'){await execute("UPDATE suppliers SET status='Archived' WHERE id=?",body.id);return Response.json({ok:true})}}
 if(path[0]==='test'){const s=await db().prepare('SELECT * FROM suppliers WHERE id=?').bind(body.id).first<any>();if(!s)throw Error('Supplier not found');const p=(await crawl(s,true)).products;await execute('UPDATE suppliers SET status=? WHERE id=?','Active',s.id);return Response.json({count:p.length,sample:p[0]})}
 if(path[0]==='pause'){await execute('UPDATE suppliers SET status=? WHERE id=?','Paused',body.id);return Response.json({ok:true})}
 if(path[0]==='settings'){for(const key of ['automatic','time','scheduler_linked'])if(body[key]!=null){if((key==='automatic'||key==='scheduler_linked')&&!['true','false'].includes(String(body[key])))throw Error('Invalid automatic setting');if(key==='time'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(body[key]))throw Error('Invalid time');await execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(body[key]))}return Response.json({ok:true})}
 if(path[0]==='review'){const r=await db().prepare('SELECT * FROM reviews WHERE id=? AND status=?').bind(body.id,'Pending').first<any>();if(!r)throw Error('Pending review not found');await db().batch([db().prepare('UPDATE reviews SET status=? WHERE id=?').bind(body.approve?'Approved':'Rejected',r.id),...(body.approve?[db().prepare('UPDATE listings SET group_id=? WHERE id=?').bind(r.target_id,r.listing_id),db().prepare("UPDATE groups SET status='Approved' WHERE id=?").bind(r.target_id)]:[]),db().prepare('INSERT INTO audit VALUES(?,?,?,?)').bind(id(),now(),body.approve?'Approve match':'Reject match',JSON.stringify(r))]);return Response.json({ok:true})}
 if(path[0]==='merge'){if(body.from===body.to)throw Error('Choose two distinct groups');const a=await db().prepare('SELECT id FROM groups WHERE id=?').bind(body.to).first();if(!a)throw Error('Target group not found');await db().batch([db().prepare('UPDATE listings SET group_id=? WHERE group_id=?').bind(body.to,body.from),db().prepare("UPDATE groups SET status='Approved' WHERE id=?").bind(body.to),db().prepare('INSERT INTO audit VALUES(?,?,?,?)').bind(id(),now(),'Merge groups',JSON.stringify(body))]);return Response.json({ok:true})}
 if(path[0]==='recover'){const job=await db().prepare("SELECT * FROM jobs WHERE status='Running' ORDER BY started DESC LIMIT 1").first<any>();if(job&&Date.now()-new Date(job.started).getTime()<600000)throw Error('Run is recent. Recovery is available after 10 minutes.');await db().batch([db().prepare("UPDATE jobs SET status='Failed - recovered',finished=? WHERE status='Running'").bind(now()),db().prepare("DELETE FROM settings WHERE key='run_lock'")]);return Response.json({ok:true})}
 if(path[0]==='group'){const lid=body.listingId;const l=await db().prepare('SELECT * FROM listings WHERE id=?').bind(lid).first<any>();if(!l)throw Error('Listing not found');const gid=body.targetId||id();if(!body.targetId)await execute('INSERT INTO groups VALUES(?,?,?,?)',gid,body.name||l.name,'Approved',now());else if(!await db().prepare('SELECT id FROM groups WHERE id=?').bind(gid).first())throw Error('Group not found');await db().batch([db().prepare('UPDATE listings SET group_id=? WHERE id=?').bind(gid,lid),db().prepare('INSERT INTO audit VALUES(?,?,?,?)').bind(id(),now(),'Move/split listing',JSON.stringify({listingId:lid,from:l.group_id,to:gid}))]);return Response.json({ok:true})}
 if(path[0]==='acknowledge'){await execute("UPDATE listings SET status='Current' WHERE id=? AND status='NEW'",body.id);return Response.json({ok:true})}
 return Response.json({error:'Unknown operation'},{status:404})}

export async function scheduledRun(){const settings=Object.fromEntries((await all('settings')).map(s=>[s.key,s.value]));await execute("INSERT INTO settings VALUES('scheduler_last_checked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",now());if(settings.automatic!=='true')return {skipped:'Automatic scraping disabled'};const time=settings.time||'09:00';const local=new Date(Date.now()+330*60000);const day=Math.floor(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())/86400000);const anchor=Math.floor(Date.UTC(2026,0,1)/86400000);const [h,m]=time.split(':').map(Number);if((day-anchor)%2!==0||local.getUTCHours()*60+local.getUTCMinutes()<h*60+m)return {skipped:'Not due'};const date=local.toISOString().slice(0,10);if(settings.scheduler_last_date===date)return {skipped:'Already ran today'};if(!(await all('suppliers')).some(s=>s.status==='Active'))return {skipped:'No active suppliers'};const jid=await createJob([]);await execute("INSERT INTO settings VALUES('scheduler_last_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",date);await runJob(jid,[]);return {id:jid,completed:true}}
