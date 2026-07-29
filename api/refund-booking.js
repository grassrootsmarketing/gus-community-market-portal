// api/refund-booking.js — F5-15/18 INTEGRATION: retailer-authorized, per-booking, idempotent refund.
import { verifyAdminSessionStrict } from './_session.js';
import { resolveDeclineRefund } from './_refund-recovery.js';
import { getBinding, sendBindingFailure } from './_env.js';
const STRIPE=process.env.STRIPE_SECRET_KEY;
let _b = null;
const rest=(p,o={})=>fetch(`${_b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:_b.serviceKey,Authorization:`Bearer ${_b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});
const one=async p=>{const r=await rest(p);return r.ok?(await r.json())[0]:null;};
async function stripeRefund(pi,cents,idem){
  const body=new URLSearchParams({payment_intent:pi,amount:String(cents)}).toString();
  const r=await fetch('https://api.stripe.com/v1/refunds',{method:'POST',headers:{Authorization:'Bearer '+STRIPE,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idem},body});
  const j=await r.json(); return r.ok?{ok:true,refund_id:j.id,amount:j.amount}:{ok:false,detail:j};
}
export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  let body={}; try{body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});}catch(_){}
  const sid=(req.headers.cookie&&/dh_session=([^;]+)/.exec(req.headers.cookie)?.[1])||body.session_id;
  const s=await verifyAdminSessionStrict(sid); if(!s.ok) return res.status(s.status).json({error:s.error});
  if(!['owner','admin','manager'].includes(s.role)) return res.status(403).json({error:'not_permitted'});
  const bk=await one(`bookings?id=eq.${encodeURIComponent(String(body.booking_id||''))}&select=id,retailer_id,payment_status,payment_intent_id,amount_paid`);
  if(!bk) return res.status(404).json({error:'booking_not_found'});
  if(bk.retailer_id!==s.retailerId && !s.isOwner) return res.status(403).json({error:'not_your_booking'});
  let refund={ok:false};
  if(bk.payment_status==='paid' && bk.payment_intent_id){
    refund=await stripeRefund(bk.payment_intent_id, Math.round(Number(bk.amount_paid||0)), 'refund-'+bk.id+'-decline');
  }
  const updated=await resolveDeclineRefund(bk.id, refund);
  return res.status(200).json({ok:true, payment_status:updated.payment_status});
}
