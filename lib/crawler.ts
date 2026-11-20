import {adapter} from './adapters';
import {decodeHtml,normalizeWooStoreProduct,robotsPolicy} from './intelligence';
import {safeUrl} from './source-url';
export interface Page{text:string;headers:Headers}
export interface CrawlProgress{stage:string;pages:number;discovered:number;expected:number|null;message?:string}
export interface CrawlResult{products:any[];allowed:(url:string)=>boolean;origin:string;complete:boolean;expected:number|null;errors:string[];pages:number;excluded:number}
interface Dependencies{read:(url:string,origin:string)=>Promise<Page>;progress?:(p:CrawlProgress)=>Promise<void>;sleep?:(ms:number)=>Promise<void>}
export function sitemapLocations(xml:string){return [...xml.matchAll(/<(?:\w+:)?(?:url|sitemap)\b[^>]*>\s*<(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?loc>/gi)].map(m=>decodeHtml(m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g,'')))}
export function productLinks(html:string,base:string){const result=new Set<string>();for(const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){try{const url=new URL(decodeHtml(m[1]),base);if(/\/(?:product|products)\//.test(url.pathname)&&!url.searchParams.has('add-to-cart')){url.hash='';result.add(url.href)}}catch{}}return [...result]}
export function nextCatalogPages(html:string,base:string){const result=new Set<string>();for(const m of html.matchAll(/<(?:a|link)\b([^>]+)>/gi)){const attributes=m[1];if(!/\brel\s*=\s*["']next["']/i.test(attributes)&&!/\bclass\s*=\s*["'][^"']*\bnext\b[^"']*\bpage-numbers\b/i.test(attributes))continue;const href=attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];if(href){try{const u=new URL(decodeHtml(href),base);u.hash='';result.add(u.href)}catch{}}}return [...result]}
export async function crawlSupplier(source:any,deps:Dependencies,test=false):Promise<CrawlResult>{
 const config=JSON.parse(source.config);if(!config.termsReviewed)throw Error('Review supplier terms before testing or activating');
 const base=safeUrl(source.url);const robots=(await deps.read(base.origin+'/robots.txt',base.origin)).text;
 const policy=robotsPolicy(robots),allowed=policy.allowed;
 if(!allowed(base.href))throw Error('robots.txt prohibits this source');
 const pause=deps.sleep||((ms:number)=>new Promise<void>(r=>setTimeout(r,ms)));
 const read=async(url:string)=>{const u=safeUrl(url);if(u.origin!==base.origin||!allowed(u.href))throw Error('Source access restrictions prohibit '+url);await pause(policy.delay*1000);return deps.read(u.href,base.origin)};
 const products=new Map<string,any>();const errors:string[]=[];let pages=0,expected:number|null=null,excluded=0;
 const progress=async(stage:string,message?:string)=>deps.progress?.({stage,pages,discovered:products.size,expected,message});
 const accept=(p:any)=>{const url=safeUrl(p.url);if(url.origin!==base.origin)throw Error('Product URL is outside the supplier origin');if(!allowed(p.url)){excluded++;return}if(!p.name)throw Error('Missing product title');products.set(p.url,p)};
 if(config.adapter==='woocommerce-api'){
  const endpoint=new URL(config.apiPath||'/wp-json/wc/store/v1/products',base.origin);if(endpoint.origin!==base.origin)throw Error('Product API must be on the supplier origin');
  let pageNumber=1,totalPages:number|null=null,retrieved=0;const rawIds=new Set<number>();
  while(true){
   const url=new URL(endpoint);url.searchParams.set('per_page','100');url.searchParams.set('page',String(pageNumber));url.searchParams.set('orderby','id');url.searchParams.set('order','asc');
   try{
    const response=await read(url.href);const payload=JSON.parse(response.text);if(!Array.isArray(payload))throw Error('Expected a public WooCommerce product array');pages++;
    const count=response.headers.get('X-WP-Total'),pageCount=response.headers.get('X-WP-TotalPages');
    if(count!==null){const n=Number(count);if(!Number.isInteger(n)||n<0)throw Error('Invalid product count');if(expected!==null&&n!==expected)errors.push('Catalog total changed during import; run again to verify complete coverage');expected=n}
    if(pageCount!==null){const n=Number(pageCount);if(!Number.isInteger(n)||n<0)throw Error('Invalid page count');totalPages=n}
    for(const item of payload){if(rawIds.has(item.id)){errors.push('Duplicate product across API pages: '+item.id);continue}rawIds.add(item.id);retrieved++;
     if(item.is_password_protected){excluded++;continue}
     try{accept(normalizeWooStoreProduct(item))}catch(e:any){errors.push(`${item.permalink||item.id}: ${e.message}`)}
    }
    await progress('Importing catalog pages');
    if(test||totalPages!==null&&pageNumber>=totalPages||totalPages===null&&payload.length<100)break;
    if(pageNumber>=10000)throw Error('API safety limit reached; import is incomplete');pageNumber++;
   }catch(e:any){errors.push(`API page ${pageNumber}: ${e.message}`);break}
  }
  if(!test&&expected!==null&&retrieved!==expected)errors.push(`Incomplete API coverage: retrieved ${retrieved} of ${expected} products`);
  if(!products.size)throw Error(errors.join('; ')||'No public products returned by the API');
  return {products:[...products.values()],allowed,origin:base.origin,complete:errors.length===0,expected,errors,pages,excluded};
 }
 const urls=new Set<string>([base.href]);
 for(const path of config.productUrls||[]){const u=new URL(path,base);if(u.origin===base.origin&&allowed(u.href))urls.add(u.href)}
 const sitemapProducts=new Set<string>();
 if(!test){
  const maps=new Set<string>([...robots.matchAll(/^sitemap\s*:\s*(\S+)/gim)].map(m=>m[1]));
  for(const path of config.sitemapUrls||[])maps.add(new URL(path,base).href);
  let traversed=0;
  for(const url of maps){
   try{if(++traversed>1000)throw Error('Sitemap safety limit reached; import is incomplete');const xml=(await read(url)).text;
    const locs=sitemapLocations(xml);
    if(/<(?:\w+:)?sitemapindex\b/i.test(xml)){
     const productMaps=locs.filter(l=>/product/i.test(new URL(l).pathname)&&!/(?:product[_-](?:cat|tag|brand))/.test(new URL(l).pathname));
     for(const child of productMaps.length?productMaps:locs){const u=new URL(child,base);if(u.origin===base.origin&&allowed(u.href))maps.add(u.href)}
    }else for(const loc of locs){const u=new URL(loc,base);if(u.origin===base.origin&&allowed(u.href)&&(/\/products?\//.test(u.pathname)||/product/i.test(new URL(url).pathname))){sitemapProducts.add(u.href);urls.add(u.href)}}
    await progress('Discovering product URLs');
   }catch(e:any){errors.push(`Sitemap ${url}: ${e.message}`)}
  }
 }
 expected=sitemapProducts.size||null;
 // Traverse to exhaustion. Bounds are explicit failures, never silent samples.
 let visited=0;
 for(const url of urls){
  if(++visited>100000){errors.push('URL safety limit reached; import is incomplete');break}
  try{
   const html=(await read(url)).text;pages++;
   const extracted=adapter(config.adapter).extract(html,url);for(const p of extracted)accept(p);
   if((sitemapProducts.has(url)||/\/products?\//.test(new URL(url).pathname))&&!extracted.length)errors.push(`No product data extracted from ${url}`);
   if(config.adapter==='woocommerce'){
    for(const link of nextCatalogPages(html,url)){const u=new URL(link);if(u.origin===base.origin&&allowed(link))urls.add(link)}
    if(!extracted.length)for(const link of productLinks(html,url))if(new URL(link).origin===base.origin&&allowed(link))urls.add(link);
   }else if(!sitemapProducts.size)for(const link of productLinks(html,url))if(new URL(link).origin===base.origin&&allowed(link))urls.add(link);
   await progress('Extracting products');
   if(test&&products.size)break;
  }catch(e:any){errors.push(`${url}: ${e.message}`)}
 }
 if(!products.size)throw Error(errors.join('; ')||'No product data found. Configure a public product API, sitemap or category page. Existing records were preserved.');
 if(!test&&expected!==null&&products.size<expected)errors.push(`Incomplete sitemap coverage: extracted ${products.size} of ${expected} products`);
 return {products:[...products.values()],allowed,origin:base.origin,complete:errors.length===0,expected,errors,pages,excluded};
}
