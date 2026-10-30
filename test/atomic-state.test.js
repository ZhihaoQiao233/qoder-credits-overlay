import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from '../src/atomic-state.js';
test('retries Windows sharing violations while preserving old valid JSON', async () => {
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'credits-atomic-')),'state.json');
 fs.writeFileSync(file,'{"old":true}');let calls=0;const delays=[];
 await atomicWriteJson(file,{new:true},{fsImpl:{...fs,renameSync(a,b){assert.deepEqual(JSON.parse(fs.readFileSync(b)),{old:true});if(++calls<3)throw Object.assign(new Error('sharing'),{code:'EPERM'});fs.renameSync(a,b);}},delay:async ms=>delays.push(ms)});
 assert.equal(calls,3);assert.deepEqual(delays,[20,50]);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{new:true});
 assert.equal(fs.readdirSync(path.dirname(file)).length,1);
});
test('persistent locks and unrelated errors keep old state and remove the temp file', async () => {
 for(const code of ['EPERM','ENOSPC']){const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'credits-atomic-')),'state.json');fs.writeFileSync(file,'{"old":true}');let calls=0;
 await assert.rejects(atomicWriteJson(file,{new:true},{fsImpl:{...fs,renameSync(){calls++;throw Object.assign(new Error(code),{code});}},delay:async()=>{}}),{code});
 assert.equal(calls,code==='EPERM'?4:1);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{old:true});assert.equal(fs.readdirSync(path.dirname(file)).length,1);}
});
