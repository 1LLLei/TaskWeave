import { RpcClient, CodexExecutor } from '../packages/adapters/src/codex';
import { randomUUID } from 'node:crypto';
const options = {
  executable: process.env.TASKWEAVE_CODEX_PATH ?? 'codex',
  workspace: process.cwd(),
  approve: async () => false,
};
const client = new RpcClient(options);
try {
  const init = await client.connect();
  console.log('PASS: real Codex app-server initialize', init.userAgent ?? '');
  const result = await client.request('thread/start', {
    cwd: process.cwd(),
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    ephemeral: true,
  });
  if (!result.thread?.id) throw new Error('Missing thread id');
  console.log('PASS: real read-only thread created');
} finally {
  client.dispose();
}
if (process.argv.includes('--execute')) {
  const executor = new CodexExecutor(options, true);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 90000);
  let success = false;
  let expectedReply = false;
  try {
    for await (const event of executor.execute(
      {
        id: randomUUID(),
        orderIndex: 0,
        title: 'Read-only integration smoke',
        instruction:
          'Do not use tools or modify files. Reply with exactly TASKWEAVE_SMOKE_OK.',
        acceptanceCriteria: [{ type: 'manual', description: 'Smoke' }],
      },
      abort.signal,
    )) {
      if (event.type === 'activity') {
        console.log(event.kind, event.text.slice(0, 500));
        if (
          event.kind === 'message' &&
          event.text.trim() === 'TASKWEAVE_SMOKE_OK'
        )
          expectedReply = true;
      }
      if (['failed', 'unknown', 'cancelled'].includes(event.type))
        throw new Error('text' in event ? event.text : event.type);
      if (event.type === 'succeeded') success = true;
    }
    if (!success) throw new Error('Turn did not complete');
    if (!expectedReply)
      throw new Error('Expected TASKWEAVE_SMOKE_OK response was not received');
    console.log('PASS: real read-only Codex turn completed');
  } finally {
    clearTimeout(timeout);
    executor.dispose();
  }
}
