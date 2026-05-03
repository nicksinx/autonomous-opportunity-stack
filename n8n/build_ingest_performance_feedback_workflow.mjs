import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pgNode } from "./build_pg_node.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "wf_ingest_performance_feedback.json");

const sqlInsertFeedback = `INSERT INTO performance_feedback
  (feedback_id, opp_id, brief_id, product_sku, feedback_date, units_sold_30d, revenue_30d,
   gross_margin_pct, return_rate_pct, ctr_pct, conversion_rate_pct, feedback_notes)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(feedback_id text, opp_id text, brief_id text, product_sku text, feedback_date date,
       units_sold_30d int, revenue_30d numeric, gross_margin_pct numeric, return_rate_pct numeric,
       ctr_pct numeric, conversion_rate_pct numeric, feedback_notes text)
ON CONFLICT (feedback_id) DO NOTHING`;

const sqlRecalibrationJoin = `SELECT
  pf.feedback_id, pf.feedback_date, pf.opp_id, pf.units_sold_30d, pf.revenue_30d,
  os.demand_score, os.competition_score, os.conversion_score, os.creative_score,
  os.margin_score, os.ops_score, os.catalog_score, os.repeat_score, os.season_score
FROM performance_feedback pf
JOIN opportunity_scores os USING (opp_id)
WHERE pf.feedback_date >= CURRENT_DATE - INTERVAL '90 days'`;

const sqlUpsertWeights = `INSERT INTO score_weights (dimension, weight, enabled, last_updated, notes)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(dimension text, weight numeric, enabled boolean, last_updated timestamptz, notes text)
ON CONFLICT (dimension) DO UPDATE SET
  weight = EXCLUDED.weight, enabled = EXCLUDED.enabled, last_updated = EXCLUDED.last_updated, notes = EXCLUDED.notes`;

const validateCode = `const payload=$input.first().json?.body||$input.first().json||{};
const source=String(payload.source||'').trim().toLowerCase();
const records=Array.isArray(payload.records)?payload.records:[];
if(!new Set(['printify','etsy','manual']).has(source)) return [{json:{__error:true,__statusCode:400,message:'Invalid source'}}];
if(!records.length) return [{json:{__error:true,__statusCode:400,message:'records[] required'}}];
const out=[];
for(const r of records){
  const sku=String(r.product_sku||'').trim(); const d=String(r.feedback_date||'').slice(0,10);
  if(!sku||!d) return [{json:{__error:true,__statusCode:400,message:'product_sku and feedback_date required'}}];
  out.push({feedback_id:'fb_'+sku+'_'+d,opp_id:String(r.opp_id||''),brief_id:String(r.brief_id||''),product_sku:sku,feedback_date:d,units_sold_30d:Number(r.units_sold_30d)||0,revenue_30d:Number(r.revenue_30d)||0,gross_margin_pct:Number(r.gross_margin_pct)||0,return_rate_pct:Number(r.return_rate_pct)||0,ctr_pct:Number(r.ctr_pct)||0,conversion_rate_pct:Number(r.conversion_rate_pct)||0,feedback_notes:String(r.feedback_notes||'source:'+source)});
}
return [{json:{records:out,__error:false}}];`;

const recalCode = `const rows=$input.all().map(i=>i.json||{}); const n=v=>{const x=Number(v);return Number.isFinite(x)?x:0};
const dims=[['demand_strength','demand_score'],['competition_gap','competition_score'],['conversion_potential','conversion_score'],['creative_diff','creative_score'],['margin_potential','margin_score'],['ops_feasibility','ops_score'],['catalog_fit','catalog_score'],['repeatability','repeat_score'],['seasonality_timing','season_score']];
const corr=(x,y)=>{if(x.length<2||x.length!==y.length)return 0;const mx=x.reduce((a,b)=>a+b,0)/x.length;const my=y.reduce((a,b)=>a+b,0)/y.length;let num=0,dx=0,dy=0;for(let i=0;i<x.length;i++){const a=x[i]-mx,b=y[i]-my;num+=a*b;dx+=a*a;dy+=b*b;}const den=Math.sqrt(dx*dy);return den?num/den:0;};
const base={demand_strength:0.2,competition_gap:0.15,conversion_potential:0.2,creative_diff:0.1,margin_potential:0.1,ops_feasibility:0.1,catalog_fit:0.05,repeatability:0.05,seasonality_timing:0.05};
const suggested={...base}; for(const [d,f] of dims){const xs=[],ys=[]; for(const r of rows){xs.push(n(r[f])); ys.push(n(r.units_sold_30d));} const c=Math.abs(corr(xs,ys)); suggested[d]=base[d]*(c>=0.5?1.2:c<0.1?0.8:1);}
const sum=Object.values(suggested).reduce((a,b)=>a+b,0)||1; const now=new Date().toISOString();
const weight_rows=dims.map(([d])=>({dimension:d,weight:Math.round((suggested[d]/sum)*10000)/10000,enabled:true,last_updated:now,notes:'auto-calibrated'}));
return [{json:{weight_rows}}];`;

const wf = {
  id: "f9000009-f009-4009-8009-000000000002",
  name: "wf_ingest_performance_feedback",
  active: false,
  nodes: [
    { parameters:{path:"performance-feedback",httpMethod:"POST",responseMode:"responseNode",options:{}}, id:"f9-101", name:"1. Webhook Trigger", type:"n8n-nodes-base.webhook", typeVersion:2, position:[0,300], webhookId:"performance-feedback-ingest" },
    { parameters:{mode:"runOnceForAllItems",language:"javaScript",jsCode:validateCode}, id:"f9-102", name:"2. Validate payload", type:"n8n-nodes-base.code", typeVersion:2, position:[220,300] },
    { parameters:{conditions:{options:{version:2,leftValue:"",caseSensitive:true,typeValidation:"strict"},conditions:[{leftValue:"={{ $json.__error === true }}",rightValue:true,operator:{type:"boolean",operation:"equals",singleValue:true}}],combinator:"and"},options:{}}, id:"f9-103", name:"3. IF validation error", type:"n8n-nodes-base.if", typeVersion:2.2, position:[440,300] },
    { ...pgNode({operation:"executeQuery",query:sqlInsertFeedback,parameters:["={{ JSON.stringify($json.records || []) }}"]}), id:"f9-104", name:"4. Insert feedback ON CONFLICT DO NOTHING", position:[660,420] },
    { ...pgNode({operation:"executeQuery",query:"SELECT COUNT(*)::int AS total_feedback_rows FROM performance_feedback"}), id:"f9-105", name:"5. Count feedback rows", position:[880,420] },
    { parameters:{conditions:{options:{version:2,leftValue:"",caseSensitive:true,typeValidation:"strict"},conditions:[{leftValue:"={{ Number($json.total_feedback_rows||0) >= 10 && Number($json.total_feedback_rows||0) % 10 === 0 }}",rightValue:true,operator:{type:"boolean",operation:"equals",singleValue:true}}],combinator:"and"},options:{}}, id:"f9-106", name:"6. IF recalibrate?", type:"n8n-nodes-base.if", typeVersion:2.2, position:[1100,420] },
    { ...pgNode({operation:"executeQuery",query:sqlRecalibrationJoin}), id:"f9-107", name:"7. Recalibration join query", position:[1320,420] },
    { parameters:{mode:"runOnceForAllItems",language:"javaScript",jsCode:recalCode}, id:"f9-108", name:"8. Compute suggested weights", type:"n8n-nodes-base.code", typeVersion:2, position:[1540,420] },
    { ...pgNode({operation:"executeQuery",query:sqlUpsertWeights,parameters:["={{ JSON.stringify($json.weight_rows || []) }}"]}), id:"f9-109", name:"9. Upsert score_weights", position:[1760,420] },
    { parameters:{mode:"runOnceForAllItems",language:"javaScript",jsCode:"return [{json:{status:'ok',records_written:Number($('2. Validate payload').first().json.records?.length||0),recalibrated:false,__statusCode:200}}];"}, id:"f9-110", name:"Build success (no recalibration)", type:"n8n-nodes-base.code", typeVersion:2, position:[1320,620] },
    { parameters:{mode:"runOnceForAllItems",language:"javaScript",jsCode:"return [{json:{status:'ok',records_written:Number($('2. Validate payload').first().json.records?.length||0),recalibrated:true,__statusCode:200}}];"}, id:"f9-111", name:"Build success (recalibrated)", type:"n8n-nodes-base.code", typeVersion:2, position:[1980,420] },
    { parameters:{mode:"runOnceForAllItems",language:"javaScript",jsCode:"return [{json:{status:'error',message:$('2. Validate payload').first().json.message||'validation failed',records_written:0,recalibrated:false,__statusCode:Number($('2. Validate payload').first().json.__statusCode||400)}}];"}, id:"f9-112", name:"Build 400 response", type:"n8n-nodes-base.code", typeVersion:2, position:[660,180] },
    { parameters:{options:{},respondWith:"json",responseBody:"={{ { status:$json.status, message:$json.message, records_written:$json.records_written, recalibrated:$json.recalibrated } }}",responseCode:"={{ Number($json.__statusCode || 200) }}"}, id:"f9-113", name:"10. Webhook Response", type:"n8n-nodes-base.respondToWebhook", typeVersion:1.1, position:[2200,500] },
  ],
  connections: {
    "1. Webhook Trigger": { main: [[{node:"2. Validate payload",type:"main",index:0}]] },
    "2. Validate payload": { main: [[{node:"3. IF validation error",type:"main",index:0}]] },
    "3. IF validation error": { main: [[{node:"Build 400 response",type:"main",index:0}],[{node:"4. Insert feedback ON CONFLICT DO NOTHING",type:"main",index:0}]] },
    "Build 400 response": { main: [[{node:"10. Webhook Response",type:"main",index:0}]] },
    "4. Insert feedback ON CONFLICT DO NOTHING": { main: [[{node:"5. Count feedback rows",type:"main",index:0}]] },
    "5. Count feedback rows": { main: [[{node:"6. IF recalibrate?",type:"main",index:0}]] },
    "6. IF recalibrate?": { main: [[{node:"7. Recalibration join query",type:"main",index:0}],[{node:"Build success (no recalibration)",type:"main",index:0}]] },
    "7. Recalibration join query": { main: [[{node:"8. Compute suggested weights",type:"main",index:0}]] },
    "8. Compute suggested weights": { main: [[{node:"9. Upsert score_weights",type:"main",index:0}]] },
    "9. Upsert score_weights": { main: [[{node:"Build success (recalibrated)",type:"main",index:0}]] },
    "Build success (no recalibration)": { main: [[{node:"10. Webhook Response",type:"main",index:0}]] },
    "Build success (recalibrated)": { main: [[{node:"10. Webhook Response",type:"main",index:0}]] },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London" },
  staticData: null,
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [{ name: "pod-research" }],
  versionId: "f9000009-f009-4009-8009-0000000000e2",
};

fs.writeFileSync(outPath, JSON.stringify([wf], null, 2), "utf8");
console.log("Wrote", outPath);
