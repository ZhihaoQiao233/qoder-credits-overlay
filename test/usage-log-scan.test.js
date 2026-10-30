import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLogIndex } from '../src/usage-log.js';

test('discovers runs through session segments, handles partial lines and UTF-8 chunks', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-scan-'));
 const segments=path.join(root,'sessions','installation-not-workspace','s1','segments');
 fs.mkdirSync(segments,{recursive:true});fs.writeFileSync(path.join(segments,'run.jsonl'),'');
 fs.mkdirSync(path.join(root,'runs','run'),{recursive:true});const file=path.join(root,'runs','run','qodercli.log');
 const pre='2026-10-30T12:27:10+08:00';
 const lines=[`${pre} DEBUG debug.message [SubAgentLifecycle] createForSubagent: requestSetId=c1, businessInfo={"id":"turn1","name":"中文","sub_task":"agent_sub_compact"}`,
 `${pre} INFO  debug.message [qoder-server-request] <-- operation=sendRemoteChatAsk status=200 serverRequestId=server1 requestSetId=c1`,
 `${pre} INFO  debug.message [QoderInferResponse] reason=agent-loop:test, sessionId=s1, qoderRequestId=r1, serverRequestId=server1, status=200`,
 `${pre} DEBUG debug.message [ForkCompletionBilling] requestIndex=0, requestId=r1, model=mmodel, credits=0.4, originalCredits=1, billable=true, creditCalculation=included`];
 const text=lines.join('\n');const split=text.indexOf('中文')+1;
 const bytes=Buffer.from(text);const byteSplit=Buffer.byteLength(text.slice(0,split))-2;
 fs.writeFileSync(file,bytes.subarray(0,byteSplit));const index=new UsageLogIndex({root});index.scan('s1');assert.equal(index.records('s1').length,0);
 fs.appendFileSync(file,bytes.subarray(byteSplit));index.scan('s1');assert.equal(index.records('s1')[0].hasMetering,false);
 fs.appendFileSync(file,'\n');index.scan('s1');assert.equal(index.records('s1')[0].credits,0.4);assert.equal(index.records('s1')[0].ownerId,'turn1');
 index.scan('s1');assert.equal(index.records('s1').length,1);
});
