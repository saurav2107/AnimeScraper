import {createJob,runJob,scheduledRun} from '../lib/service';
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    if(new URL(request.url).pathname==='/api/scheduled' && request.method==='POST') {if(request.headers.get('origin') && request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Origin rejected'},{status:403});try{return Response.json(await scheduledRun())}catch(e:any){return Response.json({error:e.message},{status:400})}}
    if(new URL(request.url).pathname==='/api/run' && request.method==='POST') {
      if(request.headers.get('origin') && request.headers.get('origin')!==new URL(request.url).origin) return Response.json({error:'Origin rejected'},{status:403});
      try {const body=await request.json() as any;const selected=Array.isArray(body.selected)?body.selected:[];const id=await createJob(selected);if(body.wait===true){await runJob(id,selected);return Response.json({id,completed:true})}ctx.waitUntil(runJob(id,selected));return Response.json({id},{status:202});}catch(e:any){return Response.json({error:e.message},{status:409});}
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};

export default worker;
