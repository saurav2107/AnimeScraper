// Adapter contract: preserve original titles and raw payloads; never infer missing fields.
import {extractProducts} from './intelligence';
export interface ExtractedProduct{name:string;url:string;image:string|null;height:number|null;material:string|null;price:number|null;currency:string|null;stock:string;raw:string}
export interface Adapter{key:string;extract(html:string,url:string):ExtractedProduct[]}
export const adapters:Record<string,Adapter>={jsonld:{key:'jsonld',extract:extractProducts}};
export function adapter(key='jsonld'){if(!adapters[key])throw Error(`Unsupported adapter: ${key}`);return adapters[key]}
