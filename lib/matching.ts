export interface MatchProviderConfig {MATCHING_API_URL?:string;MATCHING_API_TOKEN?:string;MATCHING_MODEL?:string}
// Bring-your-own multimodal provider. The endpoint must accept this documented
// contract and inspect both images, returning explicit variant equivalence.
export async function visualMatch(a:any,b:any,config:MatchProviderConfig){
 if(!config.MATCHING_API_URL||!config.MATCHING_API_TOKEN||!a.image||!b.image)return null;
 const url=new URL(config.MATCHING_API_URL);if(url.protocol!=='https:')throw Error('Matching endpoint must use HTTPS');
 const listing=(p:any)=>({name:p.name,image_url:p.image,height_cm:p.height,material:p.material,description:JSON.parse(p.raw||'{}').description??null});
 const r=await fetch(url,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.MATCHING_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({model:config.MATCHING_MODEL,task:'same_product_variant',instructions:'Compare physical collectible identity, pose, transformation, edition, accessories, height and material. Same character is insufficient. Return same_variant, confidence (0..1), reason. Use false when uncertain.',listings:[listing(a),listing(b)]}),signal:AbortSignal.timeout(6000)});
 if(!r.ok)throw Error(`Matching provider returned ${r.status}`);const result:any=await r.json();if(result.same_variant!==true||typeof result.confidence!=='number'||result.confidence<.6||result.confidence>1||typeof result.reason!=='string')return null;
 return {confidence:result.confidence,reason:'Vision provider: '+result.reason.slice(0,1000)};
}
