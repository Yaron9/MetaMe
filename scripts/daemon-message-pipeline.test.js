'use strict';

const assert = require('assert');
const { createMessagePipeline } = require('./daemon-message-pipeline');

// ── Helpers ────────────────────────────────────────────────────────

function createMockBot() {
  const sent = [];
  return {
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
    sent,
  };
}

function createMockDeps(opts = {}) {
  const activeProcesses = new Map();
  const logs = [];
  const processedMessages = [];

  const handleCommand = opts.handleCommand || (async (bot, chatId, text) => {
    processedMessages.push({ chatId, text, ts: Date.now() });
    await new Promise(r => setTimeout(r, opts.processDelay || 10));
    return { ok: true };
  });

  return {
    activeProcesses,
    handleCommand,
    resetCooldown: () => {},
    log: (level, msg) => logs.push({ level, msg }),
    _logs: logs,
    _processedMessages: processedMessages,
  };
}

function makeCtx(bot, overrides = {}) {
  return {
    bot,
    config: {},
    executeTaskByName: () => {},
    senderId: 'user1',
    readOnly: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

async function testIdleProcessing() {
  const deps = createMockDeps();
  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();

  await pipeline.processMessage('chat1', 'hello', makeCtx(bot));
  assert.strictEqual(deps._processedMessages.length, 1);
  assert.strictEqual(deps._processedMessages[0].text, 'hello');
  console.log('✓ testIdleProcessing');
}

async function testParallelChatIds() {
  const order = [];
  const deps = createMockDeps({
    handleCommand: async (bot, chatId, text) => {
      order.push(`start:${chatId}`);
      await new Promise(r => setTimeout(r, 30));
      order.push(`end:${chatId}`);
      return { ok: true };
    },
  });
  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();

  const p1 = pipeline.processMessage('chatA', 'a', makeCtx(bot));
  const p2 = pipeline.processMessage('chatB', 'b', makeCtx(bot));
  await Promise.all([p1, p2]);

  const startA = order.indexOf('start:chatA');
  const startB = order.indexOf('start:chatB');
  const endA = order.indexOf('end:chatA');
  const endB = order.indexOf('end:chatB');
  assert.ok(startA < endA && startB < endB, 'Each chat processes in order');
  assert.ok(startA < endB && startB < endA, 'Different chats run in parallel');
  console.log('✓ testParallelChatIds');
}

async function testCollectAndFlushAfterChainDies() {
  // Simulates: msg1 (processing) → msg2 (pause+collect) → msg3 (collect)
  // → chain dies → debounce → flush all as ONE call
  const processed = [];
  let firstCallResolve;

  const deps = createMockDeps({
    handleCommand: async (bot, chatId, text) => {
      processed.push(text);
      if (text === 'msg1') {
        // Simulate task that takes a while then gets interrupted
        await new Promise(r => { firstCallResolve = r; setTimeout(r, 200); });
      }
      return { ok: true };
    },
  });
  deps.activeProcesses.set('chat1', { child: null, aborted: false, engine: 'claude', killSignal: 'SIGTERM' });

  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();
  const ctx = makeCtx(bot);

  // Start first message
  const p = pipeline.processMessage('chat1', 'msg1', ctx);
  await new Promise(r => setTimeout(r, 20));

  // Follow-up → pause + collect (no debounce timer yet)
  pipeline.processMessage('chat1', 'msg2', ctx);
  await new Promise(r => setTimeout(r, 10));
  pipeline.processMessage('chat1', 'msg3', ctx);

  // Let the first task finish (simulates process dying after SIGINT)
  firstCallResolve();
  await new Promise(r => setTimeout(r, 50));

  // Chain is dead now, debounce should have started (3s)
  // Send more messages during debounce
  pipeline.processMessage('chat1', 'msg4', ctx);
  await new Promise(r => setTimeout(r, 100));
  pipeline.processMessage('chat1', 'msg5', ctx);

  // Wait for debounce (5s after msg5) + processing
  await new Promise(r => setTimeout(r, 6000));

  // Should have: msg1 (interrupted), then ONE merged prompt with all messages
  assert.strictEqual(processed.length, 2, `Should process msg1 + ONE merged flush, got ${processed.length}`);
  assert.strictEqual(processed[0], 'msg1');
  assert.ok(processed[1].includes('msg1'), 'Merged should contain original msg1');
  assert.ok(processed[1].includes('msg2'), 'Merged should contain msg2');
  assert.ok(processed[1].includes('msg5'), 'Merged should contain msg5');

  // Only ONE pause notification
  const pauseNotifs = bot.sent.filter(s => s.text.includes('⏸'));
  assert.strictEqual(pauseNotifs.length, 1);

  console.log('✓ testCollectAndFlushAfterChainDies');
}

async function testMessagesAfterFlushGoToCollecting() {
  // After flush starts processing, new messages should collect (not interrupt)
  // and produce ONE more reply after flush finishes
  const processed = [];

  const deps = createMockDeps({
    handleCommand: async (bot, chatId, text) => {
      processed.push(text);
      await new Promise(r => setTimeout(r, 100));
      return { ok: true };
    },
  });
  deps.activeProcesses.set('chat1', { child: null, aborted: false, engine: 'claude', killSignal: 'SIGTERM' });

  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();
  const ctx = makeCtx(bot);

  // msg1 processing
  const p = pipeline.processMessage('chat1', 'first', ctx);
  await new Promise(r => setTimeout(r, 20));

  // Follow-up → pause + collect
  pipeline.processMessage('chat1', 'second', ctx);

  // Wait for chain to die + debounce (5s)
  await new Promise(r => setTimeout(r, 6000));

  // Flush is now processing "first\nsecond"
  // Send more messages during flush processing
  await new Promise(r => setTimeout(r, 20));
  pipeline.processMessage('chat1', 'third', ctx);

  // Wait for flush to finish + debounce for third + processing
  await new Promise(r => setTimeout(r, 6500));

  assert.strictEqual(processed.length, 3, `Should be 3: original + flush + post-flush, got ${processed.length}`);
  assert.strictEqual(processed[0], 'first');
  assert.ok(processed[1].includes('first') && processed[1].includes('second'));
  assert.strictEqual(processed[2], 'third');

  console.log('✓ testMessagesAfterFlushGoToCollecting');
}

async function testPriorityBypassDuringCollecting() {
  const processed = [];
  const deps = createMockDeps({
    handleCommand: async (bot, chatId, text) => {
      processed.push(text);
      if (text === 'task') await new Promise(r => setTimeout(r, 200));
      return { ok: true };
    },
  });
  deps.activeProcesses.set('chat1', { child: null, aborted: false, engine: 'claude', killSignal: 'SIGTERM' });

  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();
  const ctx = makeCtx(bot);

  pipeline.processMessage('chat1', 'task', ctx);
  await new Promise(r => setTimeout(r, 20));

  // Follow-up → enters collecting mode
  pipeline.processMessage('chat1', 'follow', ctx);
  await new Promise(r => setTimeout(r, 10));

  // /stop should cancel collecting and execute immediately
  await pipeline.processMessage('chat1', '/stop', ctx);

  assert.ok(processed.includes('/stop'), '/stop should have executed');
  assert.strictEqual(pipeline._collecting.size, 0, 'Collecting should be cancelled');

  console.log('✓ testPriorityBypassDuringCollecting');
}

async function testClearQueueCancelsCollecting() {
  const deps = createMockDeps({
    handleCommand: async () => {
      await new Promise(r => setTimeout(r, 200));
      return { ok: true };
    },
  });
  deps.activeProcesses.set('chat1', { child: null, aborted: false, engine: 'claude', killSignal: 'SIGTERM' });

  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();
  const ctx = makeCtx(bot);

  pipeline.processMessage('chat1', 'task', ctx);
  await new Promise(r => setTimeout(r, 20));

  pipeline.processMessage('chat1', 'follow', ctx);
  await new Promise(r => setTimeout(r, 10));

  assert.ok(pipeline._collecting.has('chat1'), 'Should be collecting');
  pipeline.clearQueue('chat1');
  assert.ok(!pipeline._collecting.has('chat1'), 'clearQueue should cancel collecting');
  assert.strictEqual(pipeline.getQueueLength('chat1'), 0);

  console.log('✓ testClearQueueCancelsCollecting');
}

async function testIsActive() {
  const deps = createMockDeps({
    handleCommand: async () => {
      await new Promise(r => setTimeout(r, 50));
      return { ok: true };
    },
  });
  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();

  assert.strictEqual(pipeline.isActive('chat1'), false);

  const p = pipeline.processMessage('chat1', 'msg', makeCtx(bot));
  assert.strictEqual(pipeline.isActive('chat1'), true);

  await p;
  assert.strictEqual(pipeline.isActive('chat1'), false);

  console.log('✓ testIsActive');
}

async function testErrorRecovery() {
  let callCount = 0;
  const deps = createMockDeps({
    handleCommand: async () => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      return { ok: true };
    },
  });
  const pipeline = createMessagePipeline(deps);
  const bot = createMockBot();
  const ctx = makeCtx(bot);

  await pipeline.processMessage('chat1', 'msg1', ctx);
  assert.strictEqual(pipeline.isActive('chat1'), false, 'Chain should be cleaned up after error');

  await pipeline.processMessage('chat1', 'msg2', ctx);
  assert.strictEqual(callCount, 2);

  console.log('✓ testErrorRecovery');
}

async function testInterruptActive() {
  const deps = createMockDeps();
  const pipeline = createMessagePipeline(deps);

  deps.activeProcesses.set('chat1', { child: null, aborted: false, engine: 'claude', killSignal: 'SIGTERM' });
  assert.strictEqual(pipeline.interruptActive('chat1'), true);
  assert.strictEqual(deps.activeProcesses.get('chat1').aborted, true);

  assert.strictEqual(pipeline.interruptActive('chatNone'), false);

  console.log('✓ testInterruptActive');
}

// ── Runner ─────────────────────────────────────────────────────────

async function main() {
  console.log('Running daemon-message-pipeline tests...\n');
  await testIdleProcessing();
  await testParallelChatIds();
  await testCollectAndFlushAfterChainDies();
  await testMessagesAfterFlushGoToCollecting();
  await testPriorityBypassDuringCollecting();
  await testClearQueueCancelsCollecting();
  await testIsActive();
  await testErrorRecovery();
  await testInterruptActive();
  console.log('\nAll tests passed!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
