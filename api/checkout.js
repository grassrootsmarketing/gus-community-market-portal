// api/checkout.js — F5-16 INTEGRATION: session-bound, idempotent, single checkout per booking.
import { requireBrandSession } from './_booking-identity.js';
import { guardCheckout } from './_checkout-guard.js';
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_KEY=process.env.SUPABASE_SERVICE_KEY, STRIPE=process.env.STRIPE_SECRET_KEY;
const SITE=process.env.SITE_ORIGIN||'https://www.demohubhq.com';
const rest=(p,o={})=>fetch(`${SUPABASE_URL}/rest/v1/${p}`,{...o,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',...(o.headers||{})}});
async function stripe(path, params, idem){
  const body=new URLSearchParams(params).toString();
  const r=await fetch('https://api.stripe.com/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+STRIPE,'Content-Type':'application/x-www-form-urlencoded',...(idem?{'Idempotency-Key':idem}:{})},body});
  return {ok:r.ok,json:await r.json()};
}
export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  let body={}; try{body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});}catch(_){}
  const auth=await requireBrandSession(req,body); if(!auth.ok) return res.status(auth.status).json({error:auth.error});
  const g=await guardCheckout(String(body.booking_id||''),auth.brandId); if(!g.ok) return res.status(g.status).json({error:g.error});
  // price from server (venue fee stored as amount_paid at booking time, in cents)
  const bk=await (await rest(`bookings?id=eq.${encodeURIComponent(g.booking.id)}&select=amount_paid,brand_name`)).json();
  const cents=Math.max(50, Number(bk[0]?.amount_paid||3000));
  // idempotent: same booking -> same Checkout Session (no parallel/double-charge)
  const s=await stripe('checkout/sessions',{
    'mode':'payment','success_url':SITE+'/paid?b='+g.booking.id,'cancel_url':SITE+'/cancelled',
    'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(cents),
    'line_items[0][price_data][product_data][name]':'Demo booking','line_items[0][quantity]':'1',
    'payment_intent_data[metadata][booking_id]':g.booking.id
  },'checkout-'+g.booking.id);
  if(!s.ok) return res.status(502).json({error:'stripe_failed',detail:s.json});
  await rest(`bookings?id=eq.${encodeURIComponent(g.booking.id)}`,{method:'PATCH',body:JSON.stringify({stripe_session_id:s.json.id})});
  return res.status(200).json({ok:true,url:s.json.url,session_id:s.json.id});
}
