// Adapter contract: preserve original titles and raw payloads; never infer missing fields.
import {extractProducts,extractWooCommerce} from './intelligence';
export interface ExtractedProduct{name:string;url:string;image:string|null;height:number|null;material:string|null;price:number|null;currency:string|null;stock:string;raw:string}
export interface Adapter{key:string;extract(html:string,url:string):ExtractedProduct[]}
export const adapters:Record<string,Adapter>={jsonld:{key:'jsonld',extract:extractProducts},woocommerce:{key:'woocommerce',extract:(html,url)=>{const cards=extractWooCommerce(html,url);return cards.length?cards:extractProducts(html,url)}}};
export function adapter(key='jsonld'){if(!adapters[key])throw Error(`Unsupported adapter: ${key}`);return adapters[key]}
