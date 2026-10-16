#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let mode = 'success';
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line),
    reply = (result) => send({ id: m.id, result });
  if (m.method === 'initialize') reply({ userAgent: 'fixture/1' });
  else if (m.method === 'thread/start') {
    mode = m.params.sandbox === 'read-only' ? 'readonly' : 'success';
    reply({ thread: { id: 'thread-1' } });
  } else if (m.method === 'turn/start') {
    const text = m.params.input[0].text;
    reply({ turn: { id: 'turn-1' } });
    send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
    if (text.includes('WAIT_FOR_CANCEL')) return;
    if (text.includes('REQUEST_APPROVAL')) {
      send({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          command: 'echo safe',
        },
      });
      return;
    }
    send({
      method: 'item/completed',
      params: {
        threadId: 'other-thread',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: 'SHOULD_NOT_APPEAR' },
      },
    });
    const output = m.params.outputSchema
      ? JSON.stringify({
          tasks: [
            {
              title: 'Inspect requirements',
              instruction: 'Inspect the current project',
            },
          ],
        })
      : 'TASKWEAVE_SMOKE_OK';
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', text: output },
      },
    });
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          summary: ['Public summary'],
          content: ['HIDDEN_CONTENT_MUST_NOT_APPEAR'],
        },
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
  } else if (m.method === 'turn/interrupt') {
    reply({});
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted', error: null },
      },
    });
  } else if (m.id === 'approval-1') {
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: m.result?.decision === 'accept' ? 'completed' : 'failed',
          error: { message: 'Approval declined' },
        },
      },
    });
  }
});
