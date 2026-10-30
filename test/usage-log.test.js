import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageLogIndex } from '../src/usage-log.js';

const lines = (request='r1', server='server1', child='child1', owner='turn1', session='s1', credits='0.4', billable='true') => [
 `2026-10-30T12:26:49.879+08:00 DEBUG debug.message [SubAgentLifecycle] createForSubagent: requestSetId=${child}, businessInfo={"id":"${owner}","sub_task":"agent_sub_skill_evolution"}`,
 `2026-10-30T12:26:52.139+08:00 INFO  debug.message [qoder-server-request] <-- operation=sendRemoteChatAsk host=api3.qoder.sh status=200 serverRequestId=${server} duration=1ms requestSetId=${child} contractMaxAttempts=3`,
 `2026-10-30T12:26:52.139+08:00 INFO  debug.message [QoderInferResponse] reason=agent-loop:skill-evolution-fork, sessionId=${session}, qoderRequestId=${request}, serverRequestId=${server}, status=200, phase=headers_received`,
 `2026-10-30T12:27:10.553+08:00 DEBUG debug.message [ForkCompletionBilling] requestIndex=0, requestId=${request}, model=mmodel, credits=${credits}, originalCredits=999, billable=${billable}, creditCalculation=included`
];
test('joins late background cost by four explicit IDs, independent of order and time', () => {
 const index=new UsageLogIndex({root:null});
 for(const line of lines().reverse())index.addLine('run',line);
 const [r]=index.records('s1');
 assert.equal(r.ownerId,'turn1'); assert.equal(r.credits,0.4); assert.equal(r.subtask,'agent_sub_skill_evolution');
 for(const line of lines())index.addLine('run',line);
 assert.equal(index.records('s1').length,1);
});
test('does not guess an owner from a timestamp, a nearby turn, or unmatched IDs', () => {
 const index=new UsageLogIndex({root:null});
 for(const l of lines().slice(1))index.addLine('run',l);
 assert.equal(index.records('s1')[0].ownerId,null);
});
test('free reported credits are zero; missing or invalid metering stays unknown', () => {
 const index=new UsageLogIndex({root:null});
 for(const l of lines('free','sf','cf','of','s1','17.5','false'))index.addLine('run',l);
 for(const l of lines('bad','sb','cb','ob','s1','missing','true'))index.addLine('run',l);
 assert.equal(index.records('s1').find(r=>r.requestId==='free').credits,0);
 assert.equal(index.records('s1').find(r=>r.requestId==='bad').credits,null);
});
test('interleaved sessions and retries cannot steal a background request', () => {
 const index=new UsageLogIndex({root:null});
 const a=lines(),b=lines('r2','server2','child2','turn2','s2','2.5');
 for(let i=0;i<a.length;i++){index.addLine('run',a[i]);index.addLine('run',b[i]);}
 assert.equal(index.records('s1')[0].credits,0.4);assert.equal(index.records('s2')[0].ownerId,'turn2');
 index.addLine('run',a[0].replace('turn1','conflict'));
 assert.equal(index.records('s1')[0].ownerId,null);
});
test('ignores echoed tool output and refuses contradictory duplicate metering', () => {
 const index=new UsageLogIndex({root:null});
 for(const l of lines())index.addLine('run',l);
 index.addLine('run','2026-10-30T12:27:10Z INFO tool.result '+lines()[3]);
 assert.equal(index.records('s1')[0].credits,0.4);
 index.addLine('run',lines('r1','server1','child1','turn1','s1','5')[3]);
 assert.equal(index.records('s1')[0].credits,null);
});
test('persists normalized evidence and deduplicates after restart', () => {
 const first=new UsageLogIndex({root:null});for(const l of lines())first.addLine('run',l);
 const next=new UsageLogIndex({root:null, saved:first.export()});
 for(const l of lines())next.addLine('run',l);
 assert.deepEqual(next.records('s1'),first.records('s1'));
});
test('preserves unassigned real charges and proven ownership across log retention gaps', () => {
 const unresolved=new UsageLogIndex({root:null});for(const l of lines().slice(1))unresolved.addLine('run',l);
 const restored=new UsageLogIndex({root:null,saved:unresolved.export()});
 assert.equal(restored.records('s1')[0].credits,0.4);assert.equal(restored.records('s1')[0].ownerId,null);
 const proven=new UsageLogIndex({root:null});for(const l of lines())proven.addLine('run',l);
 const partial=new UsageLogIndex({root:null,saved:proven.export()});for(const l of lines().slice(1))partial.addLine('run',l);
 assert.equal(partial.records('s1')[0].ownerId,'turn1');
});
export { lines as usageLines };
