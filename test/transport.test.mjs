import test from 'node:test';
import assert from 'node:assert/strict';
import { sendRequest } from '../src/transport.mjs';
test('remote transport preserves JSON and Unicode through stdin without command interpolation', async () => {
  const program = process.execPath;
  const args = ['-e', `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:true,result:JSON.parse(data)})))`];
  const request = { params: { text: '안녕 $HOME `x` "quotes"\nline two' } };
  assert.deepEqual(await sendRequest({ program, args }, request), request);
});
test('transport timeout reports an unknown remote outcome instead of retrying', async () => {
  await assert.rejects(sendRequest({ program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, {}, { timeoutMs: 50 }), /unverifiable/i);
});
