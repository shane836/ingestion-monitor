import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyCycle, emailSettings } from '../src/notify.mjs';

const settings={enabled:true,key:'test-private',from:'Monitor <monitor@example.com>',to:'owner@example.com'};
const results=[{project:'sample',fingerprint:'incident-a',issues:[{key:'browser',message:'Missing feed'}]}];
test('sends one incident email, deduplicates it, and sends recovery',async()=>{
 const state={}; let calls=0;
 const fetch=async(url,options)=>{
  calls++;
  assert.equal(url,'https://api.resend.com/emails');
  const body=JSON.parse(options.body);
  assert.deepEqual(body.to,['owner@example.com']);
  assert.doesNotMatch(body.text,/test-private/);
  assert.ok(options.headers['Idempotency-Key']);
  return new Response(JSON.stringify({id:`email-${calls}`}));
 };
 const first=await notifyCycle(results,state,settings,{fetch});
 assert.equal(first.id,'email-1');
 await notifyCycle(results,state,settings,{fetch});
 assert.equal(calls,1);
 await notifyCycle([{project:'sample',fingerprint:null,issues:[]}],state,settings,{fetch});
 assert.equal(calls,2);
});
test('email errors remain visible and retry without starting another repair',async()=>{
 const state={};
 await notifyCycle(results,state,settings,{fetch:async()=>new Response('{}',{status:503})});
 assert.match(state._notification.error,/503/);
 assert.equal(state._notification.key,undefined);
 await notifyCycle(results,state,settings,{fetch:async()=>new Response('{"id":"retried"}')});
 assert.equal(state._notification.id,'retried');
 assert.equal(state._notification.error,null);
});
test('disabled email never sends; enabled email requires one private recipient',async()=>{
 assert.equal(await notifyCycle(results,{}, {enabled:false},{fetch:()=>assert.fail('unexpected send')}),null);
 assert.throws(()=>emailSettings({MONITOR_EMAIL_ENABLED:'true'}),/required/);
 assert.throws(()=>emailSettings({MONITOR_EMAIL_ENABLED:'true',RESEND_API_KEY:'test',MONITOR_EMAIL_FROM:'a@example.com',MONITOR_EMAIL_TO:'a@example.com,b@example.com'}),/one recipient/);
});
