import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence } from '../src/local-repair.mjs';

test('collects bounded failure evidence once per run and excludes credentials and SQL', async () => {
  let calls=0;
  const issue={key:'github:job',message:'Failed ingestion job; run 123'};
  const evidence=await collectEvidence({repo:'owner/repo'},[issue,issue],async(command,args)=>{
    calls++;
    assert.equal(command,'gh');
    assert.deepEqual(args,['run','view','123','--repo','owner/repo','--log-failed']);
    return ['Error: HTTP 405 upstream blocked','Error: Authorization: Bearer private','Error: INSERT INTO production_table VALUES (1)','Error: API_KEY=private',...Array.from({length:100},()=>`Error: ${'x'.repeat(500)}`)].join('\n');
  });
  assert.equal(calls,1);
  assert.equal(evidence.logs[0].run,'123');
  assert.ok(evidence.logs[0].excerpt.length<=12000);
  assert.doesNotMatch(JSON.stringify(evidence),/private|production_table/);
});

test('surfaces unavailable logs and does not fetch for heartbeat-only incidents',async()=>{
  const execute=async()=>{throw new Error('unavailable');};
  const result=await collectEvidence({repo:'owner/repo'},[{key:'github:job',message:'failed; run 123'}],execute);
  assert.equal(result.logs[0].error,'Failure logs unavailable; inspect the host command log.');
  assert.deepEqual((await collectEvidence({repo:'owner/repo'},[{key:'heartbeat:stale',message:'stale'}],()=>assert.fail('unexpected request'))).logs,[]);
});
