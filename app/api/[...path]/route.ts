import {api} from '../../../lib/service';
async function handle(req:Request,{params}:any){try{if(req.method!=='GET'){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return Response.json({error:'Origin rejected'},{status:403})}return await api(req,(await params).path)}catch(e:any){return Response.json({error:e.message},{status:400})}}
export const GET=handle;export const POST=handle;export const DELETE=handle;
