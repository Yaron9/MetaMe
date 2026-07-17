'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _private, createTaskScheduler } = require('./daemon-task-scheduler');

const {
  parseAtTime,
  parseDays,
  nextClockRunAfter,
  buildTaskSchedule,
  computeInitialNextRun,
  claimScheduledTask,
  mergeTaskScopedState,
  recoverInterruptedClaims,
  finalizeScheduledClaim,
  nextRunAfter,
  resolveTaskEngine,
  isModelBackedTask,
  formatModelTaskNotification,
  parseScriptTaskOutput,
  MODEL_RETRY_DELAYS_MS,
} = _private;

function nextDayOfWeek(base, day) {
  const d = new Date(base);
  while (d.getDay() !== day) d.setDate(d.getDate() + 1);
  return d;
}

describe('daemon-task-scheduler private helpers', () => {
  it('allows explicit agy for enabled scoped project and background tasks', () => {
    const task = { engine: 'agy', _project: { key: 'munger' } };
    const enabled = {
      daemon: { experimental_engines: { agy: { enabled: true, allowed_projects: ['munger'] } } },
      projects: { munger: { fallback_engine: 'codex' } },
    };
    assert.equal(resolveTaskEngine(task, enabled).engine, 'agy');
    assert.equal(resolveTaskEngine({ engine: 'agy' }, enabled).engine, 'agy');
    assert.equal(resolveTaskEngine(task, { projects: enabled.projects }).engine, 'codex');
  });
  it('inherits the daemon engine when a task and project do not override it', () => {
    assert.equal(resolveTaskEngine({ name: 'memory-extract' }, {}, 'codex').engine, 'codex');
  });

  it('claims each scheduled heartbeat exactly once', () => {
    const state = { tasks: {} };
    const now = new Date('2026-07-15T10:00:00.000Z');
    const first = claimScheduledTask(state, 'wiki-sync', now.getTime(), 'boot-a', now);
    const duplicate = claimScheduledTask(state, 'wiki-sync', now.getTime(), 'boot-a', now);
    assert.equal(first.claimed, true);
    assert.equal(duplicate.claimed, false);
    assert.equal(state.tasks['wiki-sync'].last_claimed_schedule, now.toISOString());
  });

  it('does not erase another task claim when an async task completes', () => {
    const current = { tasks: {
      first: { status: 'running' },
      second: { status: 'running', last_claimed_schedule: '2026-07-15T10:00:00.000Z' },
    } };
    const staleCompletion = { tasks: { first: { status: 'success', last_run: '2026-07-15T10:01:00.000Z' } } };
    const merged = mergeTaskScopedState(current, staleCompletion, 'first');
    assert.equal(merged.tasks.first.status, 'success');
    assert.equal(merged.tasks.second.last_claimed_schedule, '2026-07-15T10:00:00.000Z');
  });

  it('marks a previous boot claim interrupted without replaying it', () => {
    const state = { tasks: { scan: {
      status: 'running', execution_boot_id: 'boot-old',
      last_claimed_at: '2026-07-15T09:00:00.000Z',
    } } };
    const recovered = recoverInterruptedClaims(
      state, ['scan'], 'boot-new', new Date('2026-07-15T10:00:00.000Z')
    );
    assert.deepEqual(recovered, ['scan']);
    assert.equal(state.tasks.scan.status, 'interrupted');
    assert.equal(state.tasks.scan.error, 'daemon_restarted_during_task');
  });

  it('recovers an interrupted model task into the durable retry queue', () => {
    const state = { tasks: { 'wiki-sync': {
      status: 'running', execution_boot_id: 'boot-old', attempt: 1,
    } } };
    recoverInterruptedClaims(
      state,
      ['wiki-sync'],
      'boot-new',
      new Date('2026-07-15T10:00:00.000Z'),
      new Set(['wiki-sync']),
    );
    assert.equal(state.tasks['wiki-sync'].status, 'retry_pending');
    assert.equal(state.tasks['wiki-sync'].next_retry_at, '2026-07-15T10:00:00.000Z');
  });

  it('makes an interrupted third model attempt terminal', () => {
    const state = { tasks: { 'wiki-sync': {
      status: 'running', execution_boot_id: 'boot-old', attempt: 3,
    } } };
    recoverInterruptedClaims(
      state,
      ['wiki-sync'],
      'boot-new',
      new Date('2026-07-15T10:00:00.000Z'),
      new Set(['wiki-sync']),
    );
    assert.equal(state.tasks['wiki-sync'].status, 'error');
    assert.equal(state.tasks['wiki-sync'].error_code, 'DAEMON_RESTARTED');
    assert.equal(state.tasks['wiki-sync'].next_retry_at, undefined);
  });

  it('persists two model retries and makes the third failure terminal', () => {
    const now = new Date('2026-07-15T10:00:00.000Z');
    const state = { tasks: { wiki: {
      status: 'error', execution_boot_id: 'boot-a', attempt: 1,
    } } };
    assert.equal(finalizeScheduledClaim(
      state, 'wiki', 'boot-a', { success: false, error: 'timeout', errorCode: 'TIMEOUT' },
      now, { modelBacked: true, retryDelaysMs: MODEL_RETRY_DELAYS_MS },
    ), true);
    assert.equal(state.tasks.wiki.status, 'retry_pending');
    assert.equal(state.tasks.wiki.next_retry_at, '2026-07-15T10:01:00.000Z');

    state.tasks.wiki = { ...state.tasks.wiki, status: 'error', attempt: 2 };
    finalizeScheduledClaim(
      state, 'wiki', 'boot-a', { success: false, error: 'timeout', errorCode: 'TIMEOUT' },
      now, { modelBacked: true, retryDelaysMs: MODEL_RETRY_DELAYS_MS },
    );
    assert.equal(state.tasks.wiki.next_retry_at, '2026-07-15T10:05:00.000Z');

    state.tasks.wiki = { ...state.tasks.wiki, status: 'error', attempt: 3 };
    finalizeScheduledClaim(
      state, 'wiki', 'boot-a', { success: false, error: 'timeout', errorCode: 'TIMEOUT' },
      now, { modelBacked: true, retryDelaysMs: MODEL_RETRY_DELAYS_MS },
    );
    assert.equal(state.tasks.wiki.status, 'error');
    assert.equal(state.tasks.wiki.next_retry_at, undefined);
  });

  it('clears stale retry errors after a successful retry', () => {
    const state = { tasks: { wiki: {
      status: 'running', execution_boot_id: 'boot-a', attempt: 2,
      next_retry_at: '2026-07-15T10:05:00.000Z', error: 'timeout', error_code: 'TIMEOUT',
    } } };
    finalizeScheduledClaim(
      state, 'wiki', 'boot-a', { success: true, output: 'done' },
      new Date('2026-07-15T10:01:00.000Z'), { modelBacked: true },
    );
    assert.equal(state.tasks.wiki.status, 'success');
    assert.equal(state.tasks.wiki.next_retry_at, undefined);
    assert.equal(state.tasks.wiki.error, undefined);
    assert.equal(state.tasks.wiki.error_code, undefined);
  });

  it('classifies only inference tasks as model-backed and formats safe admin notices', () => {
    const modelTasks = [
      'cognitive-distill', 'memory-extract', 'skill-evolve', 'self-reflect',
      'nightly-reflect', 'wiki-sync', 'daemon-health-scan',
    ];
    const deterministicTasks = ['memory-gc', 'memory-index', 'embedding', 'openwiki-sync'];
    for (const name of modelTasks) assert.equal(isModelBackedTask({ name, type: 'script' }), true, name);
    for (const name of deterministicTasks) assert.equal(isModelBackedTask({ name, type: 'script' }), false, name);
    assert.equal(isModelBackedTask({ name: 'custom', prompt: 'work' }), true);
    const message = formatModelTaskNotification(
      { name: 'wiki-sync' },
      { success: false, errorCode: 'AUTH', error: 'api_key=secret-value failed' },
      { attempt: 3 },
    );
    assert.match(message, /3\/3/);
    assert.doesNotMatch(message, /secret-value/);
  });

  it('parses the Unix script skip marker without leaking it into output', () => {
    assert.deepEqual(
      parseScriptTaskOutput('checked input\n__METAME_TASK_SKIPPED__:no_sessions\n'),
      { skipped: true, skipReason: 'no_sessions', output: 'checked input' },
    );
  });

  it('closes skipped and thrown claims without advancing last_run for a skip', () => {
    const skipped = { tasks: { scan: { status: 'running', execution_boot_id: 'boot-a', last_run: '2026-07-14T00:00:00.000Z' } } };
    assert.equal(finalizeScheduledClaim(skipped, 'scan', 'boot-a', {
      success: false, skipped: true, error: 'budget_exceeded',
    }, new Date('2026-07-15T10:00:00.000Z')), true);
    assert.equal(skipped.tasks.scan.status, 'skipped');
    assert.equal(skipped.tasks.scan.last_run, '2026-07-14T00:00:00.000Z');

    const failed = { tasks: { scan: { status: 'running', execution_boot_id: 'boot-a' } } };
    finalizeScheduledClaim(failed, 'scan', 'boot-a', { success: false, error: 'boom' }, new Date('2026-07-15T10:00:00.000Z'));
    assert.equal(failed.tasks.scan.status, 'error');
    assert.equal(failed.tasks.scan.last_run, '2026-07-15T10:00:00.000Z');
  });

  it('uses the last claim to preserve cadence after a daemon restart', () => {
    const now = Date.parse('2026-07-15T10:00:00.000Z');
    const next = computeInitialNextRun(
      { name: 'scan' }, { mode: 'interval', intervalSec: 3600 },
      { tasks: { scan: { last_claimed_at: '2026-07-15T09:30:00.000Z' } } },
      now, 60, 1,
    );
    assert.equal(next, Date.parse('2026-07-15T10:30:00.000Z'));
  });

  it('prefers task then project engine over the daemon default', () => {
    const config = { projects: { research: { engine: 'codex' } } };
    const scoped = { name: 'wiki-sync', _project: { key: 'research' } };
    assert.equal(resolveTaskEngine(scoped, config, 'claude').engine, 'codex');
    assert.equal(resolveTaskEngine({ ...scoped, engine: 'claude' }, config, 'codex').engine, 'claude');
  });
  it('parses HH:MM time for clock tasks', () => {
    assert.deepEqual(parseAtTime('09:30'), { hour: 9, minute: 30 });
    assert.deepEqual(parseAtTime('23:59'), { hour: 23, minute: 59 });
    assert.equal(parseAtTime('24:00'), null);
    assert.equal(parseAtTime('9:7'), null);
  });

  it('parses days keywords and weekday names', () => {
    assert.deepEqual([...parseDays('weekdays').days], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseDays('weekends').days], [0, 6]);
    assert.deepEqual([...parseDays(['mon', 'wed', 'fri']).days], [1, 3, 5]);
    assert.equal(parseDays('daily').days, null);
    assert.equal(parseDays().days, null);
    assert.equal(parseDays('funday').ok, false);
  });

  it('computes next run for daily fixed-time schedule', () => {
    const schedule = { mode: 'clock', hour: 9, minute: 30, days: null };
    const fromBefore = new Date(2026, 1, 25, 8, 0, 0, 0).getTime();
    const fromAfter = new Date(2026, 1, 25, 10, 0, 0, 0).getTime();

    const next1 = new Date(nextClockRunAfter(schedule, fromBefore));
    const next2 = new Date(nextClockRunAfter(schedule, fromAfter));

    assert.equal(next1.getHours(), 9);
    assert.equal(next1.getMinutes(), 30);
    assert.equal(next1.getDate(), 25);

    assert.equal(next2.getHours(), 9);
    assert.equal(next2.getMinutes(), 30);
    assert.equal(next2.getDate(), 26);
  });

  it('computes next run for weekday-only fixed-time schedule', () => {
    const saturdayBase = nextDayOfWeek(new Date(2026, 1, 1, 8, 0, 0, 0), 6);
    const schedule = { mode: 'clock', hour: 9, minute: 0, days: parseDays('weekdays').days };
    const next = new Date(nextClockRunAfter(schedule, saturdayBase.getTime()));
    const monday = nextDayOfWeek(new Date(saturdayBase), 1);

    assert.equal(next.getDay(), 1);
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 0);
    assert.equal(next.getDate(), monday.getDate());
    assert.equal(next.getMonth(), monday.getMonth());
    assert.equal(next.getFullYear(), monday.getFullYear());
  });

  it('builds interval or clock schedule from task config', () => {
    const intervalTask = { name: 'a', interval: '2h' };
    const clockTask = { name: 'b', at: '07:15', days: 'weekdays' };

    const interval = buildTaskSchedule(intervalTask, () => 7200);
    const clock = buildTaskSchedule(clockTask, () => 3600);
    const invalid = buildTaskSchedule({ name: 'bad', at: '25:99' }, () => 3600);

    assert.equal(interval.ok, true);
    assert.equal(interval.schedule.mode, 'interval');
    assert.equal(interval.schedule.intervalSec, 7200);

    assert.equal(clock.ok, true);
    assert.equal(clock.schedule.mode, 'clock');
    assert.equal(clock.schedule.hour, 7);
    assert.equal(clock.schedule.minute, 15);
    assert.deepEqual([...clock.schedule.days], [1, 2, 3, 4, 5]);

    assert.equal(invalid.ok, false);
  });

  it('does catch-up for missed fixed-time runs and computes next run after execution', () => {
    const task = { name: 'daily-report', at: '09:00' };
    const schedule = { mode: 'clock', hour: 9, minute: 0, days: null };
    const now = new Date(2026, 1, 25, 10, 0, 0, 0).getTime();
    const yesterday = new Date(2026, 1, 24, 9, 0, 0, 0).toISOString();
    const state = { tasks: { 'daily-report': { last_run: yesterday } } };

    const initial = computeInitialNextRun(task, schedule, state, now, 60, 1);
    const next = new Date(nextRunAfter(schedule, now));

    assert.equal(initial, now);
    assert.equal(next.getDate(), 26);
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 0);
  });
});

describe('checkPrecondition logging semantics', () => {
  function makeScheduler() {
    const logs = [];
    const scheduler = createTaskScheduler({
      fs: require('fs'),
      path: require('path'),
      HOME: require('os').homedir(),
      execSync: () => '',
      log: (level, msg) => logs.push({ level, msg }),
    });
    return { scheduler, logs };
  }

  it('treats a missing `test -s` file as a benign skip, not a failure', () => {
    const { scheduler, logs } = makeScheduler();
    const result = scheduler.checkPrecondition({
      name: 'cognitive-distill',
      precondition: 'test -s /nonexistent/metame/raw_signals.jsonl',
    });

    assert.equal(result.pass, false);
    // A gating precondition that isn't met is a SKIP, not an error. It must
    // not be worded as "failed": the ops log scanner treats recurring
    // "failed" lines as errors and spawns false "Fix recurring error" missions.
    const msg = logs.map((l) => l.msg).join('\n');
    assert.doesNotMatch(msg, /failed/i);
  });
});

describe('background runtime integration', () => {
  it('passes the resolved Codex engine to script tasks', () => {
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: require('os').homedir(),
      execSync: (cmd, options) => { calls.push({ cmd, env: options.env }); return ''; },
      loadState: () => state, saveState: () => {}, checkBudget: () => true,
      recordTokens: () => {}, log: () => {}, getDefaultEngine: () => 'codex',
    });

    const result = scheduler.executeTask({
      name: 'memory-extract', type: 'script', command: 'node ~/.metame/memory-extract.js',
    }, { daemon: {} });

    assert.equal(result.success, true);
    assert.equal(calls[0].env.METAME_ENGINE, 'codex');
    assert.equal(calls[0].env.METAME_DISTILL_ENGINE, 'codex');
    assert.equal(calls[0].env.METAME_INTERNAL_PROMPT, '1');
  });

  it('routes unscoped script tasks through the configured agy distill engine', () => {
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: '/tmp/test-home', parseInterval: () => 60,
      execSync: (cmd, options) => { calls.push({ cmd, env: options.env }); return ''; },
      loadState: () => state, saveState: () => {}, checkBudget: () => true,
      recordTokens: () => {}, log: () => {}, getDefaultEngine: () => 'codex',
      getDistillEngine: () => 'agy',
    });

    const result = scheduler.executeTask({
      name: 'wiki-sync', type: 'script', command: 'node ~/.metame/wiki-reflect.js',
    }, { daemon: {} });

    assert.equal(result.success, true);
    assert.equal(calls[0].env.METAME_ENGINE, 'agy');
    assert.equal(calls[0].env.METAME_DISTILL_ENGINE, 'agy');
  });

  it('simulates every canonical model-backed maintenance task on AGY', () => {
    const tasks = [
      ['cognitive-distill', 'distill.js'],
      ['memory-extract', 'memory-extract.js'],
      ['skill-evolve', 'skill-evolution.js'],
      ['self-reflect', 'self-reflect.js'],
      ['nightly-reflect', 'memory-nightly-reflect.js'],
      ['wiki-sync', 'wiki-reflect.js'],
      ['daemon-health-scan', 'daemon-health-scan.js'],
    ];
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: '/tmp/metame-task-matrix',
      execSync: (cmd, options) => { calls.push({ cmd, env: options.env }); return `${cmd} complete`; },
      loadState: () => state, saveState: () => {}, checkBudget: () => true,
      recordTokens: () => {}, log: () => {}, getDistillEngine: () => 'agy',
    });
    for (const [name, file] of tasks) {
      const result = scheduler.executeTask({
        name, type: 'script', command: `node ~/.metame/${file}`,
      }, { daemon: {} });
      assert.equal(result.success, true, name);
    }
    assert.equal(calls.length, tasks.length);
    for (const call of calls) {
      assert.equal(call.env.METAME_ENGINE, 'agy');
      assert.equal(call.env.METAME_DISTILL_ENGINE, 'agy');
      assert.equal(call.env.METAME_INTERNAL_PROMPT, '1');
      assert.equal(call.env.METAME_TASK_ATTEMPT, '1');
    }
  });

  it('does not label deterministic maintenance scripts as agy tasks', () => {
    const calls = [];
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: '/tmp/test-home',
      execSync: (_cmd, options) => { calls.push(options.env); return ''; },
      loadState: () => ({ tasks: {} }), saveState: () => {}, checkBudget: () => true,
      recordTokens: () => {}, log: () => {}, getDistillEngine: () => 'agy',
    });
    const result = scheduler.executeTask({
      name: 'memory-gc', type: 'script', command: 'node ~/.metame/memory-gc.js',
    }, {});
    assert.equal(result.success, true);
    assert.equal(calls[0].METAME_ENGINE, undefined);
    assert.equal(calls[0].METAME_DISTILL_ENGINE, undefined);
  });

  it('treats a script no-input marker as a skip instead of a successful model run', () => {
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: '/tmp/test-home',
      execSync: () => 'nothing to process\n__METAME_TASK_SKIPPED__:no_sessions',
      loadState: () => ({ tasks: {} }), saveState: () => {}, checkBudget: () => true,
      recordTokens: () => {}, log: () => {}, getDistillEngine: () => 'agy',
    });
    const result = scheduler.executeTask({
      name: 'memory-extract', type: 'script', command: 'node ~/.metame/memory-extract.js',
    }, {});
    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.equal(result.error, 'no_sessions');
    assert.doesNotMatch(result.output, /METAME_TASK_SKIPPED/);
  });

  it('uses the agy default model instead of mapping the distill Claude model', async () => {
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: require('os').homedir(),
      execSync: () => '', parseInterval: () => 60, loadState: () => state, saveState: () => {},
      checkBudget: () => true, recordTokens: () => {}, buildProfilePreamble: () => '',
      getDistillModel: () => 'haiku', log: () => {},
      backgroundRunner: { startTurn: async options => { calls.push(options); return { ok: true, output: 'done' }; } },
    });
    const config = {
      daemon: { experimental_engines: { agy: { enabled: true, allowed_projects: ['digital_me'] } } },
      projects: { digital_me: { engine: 'agy', fallback_engine: 'claude' } },
    };
    const completed = await scheduler.executeTask({
      name: 'agy-news', prompt: 'news', engine: 'agy', _project: { key: 'digital_me' },
    }, config);
    assert.equal(completed.success, true);
    assert.equal(calls[0].engine, 'agy');
    assert.equal(calls[0].model, 'Gemini 3.5 Flash (Medium)');
    assert.equal(calls[0].readOnly, true);
    assert.equal(calls[0].forbidTools, true);
    assert.deepEqual(calls[0].allowedTools, []);
    assert.equal(calls[0].mcpConfig, '');
    assert.match(calls[0].cwd, /background-inference$/);
  });

  it('maps a legacy Claude task model to an agy-supported label', async () => {
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: require('os').homedir(),
      execSync: () => '', parseInterval: () => 60, loadState: () => state, saveState: () => {},
      checkBudget: () => true, recordTokens: () => {}, buildProfilePreamble: () => '',
      getDistillModel: () => 'haiku', log: () => {},
      backgroundRunner: { startTurn: async options => { calls.push(options); return { ok: true, output: 'done' }; } },
    });
    const config = {
      daemon: { experimental_engines: { agy: { enabled: true, allowed_projects: ['munger'] } } },
      projects: { munger: { engine: 'agy', fallback_engine: 'claude' } },
    };

    const completed = await scheduler.executeTask({
      name: 'morning-market-brief', prompt: 'brief', engine: 'agy', model: 'claude-sonnet-4-6', _project: { key: 'munger' },
    }, config);

    assert.equal(completed.success, true);
    assert.equal(calls[0].model, 'Claude Sonnet 4.6 (Thinking)');
  });

  it('routes a Codex heartbeat task through the shared background runner', async () => {
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'),
      path: require('path'),
      HOME: require('os').homedir(),
      execSync: () => '',
      parseInterval: () => 60,
      loadState: () => state,
      saveState: () => {},
      checkBudget: () => true,
      recordTokens: () => {},
      buildProfilePreamble: () => 'profile\n',
      getDistillModel: () => 'haiku',
      log: () => {},
      backgroundRunner: {
        startTurn: async options => {
          calls.push(options);
          return { ok: true, output: 'done', sessionId: 'codex-thread-1' };
        },
      },
    });
    const completed = await scheduler.executeTask({
      name: 'codex-task',
      prompt: 'inspect',
      engine: 'codex',
      persistent_session: true,
    }, { daemon: { models: { codex: 'auto' } } });

    assert.equal(completed.success, true);
    assert.equal(calls[0].engine, 'codex');
    assert.equal(calls[0].structured, false);
    assert.equal(state.tasks['codex-task'].session_id, 'codex-thread-1');
  });

  it('resumes Codex workflow with the native thread id returned by step one', async () => {
    const calls = [];
    const state = { tasks: {} };
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: require('os').homedir(),
      execSync: () => '', parseInterval: () => 60, loadState: () => state, saveState: () => {},
      checkBudget: () => true, recordTokens: () => {}, buildProfilePreamble: () => '',
      getDistillModel: () => 'haiku', getDaemonProviderEnv: () => ({ PROVIDER: 'daemon' }),
      log: () => {},
      backgroundRunner: {
        startTurn: async options => {
          calls.push(options);
          return { ok: true, output: 'done', sessionId: 'native-codex-thread' };
        },
      },
    });
    const completed = await scheduler.executeTask({
      name: 'codex-flow', type: 'workflow', engine: 'codex',
      steps: [{ prompt: 'one' }, { prompt: 'two' }],
    }, { daemon: {} });
    assert.equal(completed.success, true);
    assert.equal(calls[1].sessionRef.id, 'native-codex-thread');
    assert.equal(calls[1].sessionRef.started, true);
    assert.equal(calls[0].internalPrompt, true);
    assert.deepEqual(calls[0].providerEnv, { PROVIDER: 'daemon' });
    assert.equal(calls[0].readOnly, true);
    assert.equal(calls[0].forbidTools, true);
    assert.deepEqual(calls[0].allowedTools, []);
    assert.equal(calls[0].mcpConfig, '');
  });
});

describe('subconscious retry and notification integration', () => {
  function makeStateStore(initial = { tasks: {} }) {
    let value = structuredClone(initial);
    return {
      load: () => structuredClone(value),
      save: next => { value = structuredClone(next); },
      get: () => structuredClone(value),
    };
  }

  function startModelTask(execSync, notifications, taskOverrides = {}, initialState) {
    const store = makeStateStore(initialState);
    const scheduler = createTaskScheduler({
      fs: require('fs'), path: require('path'), HOME: '/tmp/metame-retry-test',
      execSync, parseInterval: () => 3600,
      loadState: store.load, saveState: store.save,
      checkBudget: () => true, recordTokens: () => {}, log: () => {},
      physiologicalHeartbeat: () => {}, isUserIdle: () => false,
      isInSleepMode: () => false, setSleepMode: () => {},
      getDistillEngine: () => 'agy', modelRetryDelaysMs: [5, 10],
    });
    const timer = scheduler.startHeartbeat({
      daemon: { heartbeat_check_interval: 0.005 },
      heartbeat: { tasks: [{
        name: 'memory-extract', type: 'script', model_backed: true,
        command: 'node ~/.metame/memory-extract.js', interval: '1h',
        ...taskOverrides,
      }] },
    }, null, null, async message => { notifications.push(message); });
    return { timer, store };
  }

  it('retries twice, then sends one success notice to the admin channel', async (t) => {
    let attempts = 0;
    const notifications = [];
    const { timer, store } = startModelTask(() => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('temporary timeout'), { code: 'TIMEOUT' });
      return 'memory extraction complete';
    }, notifications);
    t.after(() => clearInterval(timer));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(attempts, 3);
    assert.equal(store.get().tasks['memory-extract'].status, 'success');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /AGY 潜意识任务完成/);
    assert.match(notifications[0], /尝试 3\/3/);
  });

  it('retries twice, then sends one terminal failure notice to the admin channel', async (t) => {
    let attempts = 0;
    const notifications = [];
    const { timer, store } = startModelTask(() => {
      attempts++;
      throw Object.assign(new Error('still unavailable'), { code: 'AUTH' });
    }, notifications);
    t.after(() => clearInterval(timer));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(attempts, 3);
    assert.equal(store.get().tasks['memory-extract'].status, 'error');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /AGY 潜意识任务失败/);
    assert.match(notifications[0], /已尝试 3\/3/);
  });

  it('does not notify or retry a no-input precondition skip', async (t) => {
    let attempts = 0;
    const notifications = [];
    const { timer, store } = startModelTask(() => { attempts++; return 'unused'; }, notifications, {
      precondition: 'test -s /nonexistent/metame/no-input.jsonl',
    });
    t.after(() => clearInterval(timer));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(attempts, 0);
    assert.equal(store.get().tasks['memory-extract'].status, 'skipped');
    assert.equal(notifications.length, 0);
  });

  it('notifies a third attempt interrupted by daemon restart as terminal failure', async (t) => {
    const notifications = [];
    const { timer, store } = startModelTask(() => 'unused', notifications, {}, {
      tasks: { 'memory-extract': {
        status: 'running', attempt: 3, execution_boot_id: 'previous-boot',
      } },
    });
    t.after(() => clearInterval(timer));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.get().tasks['memory-extract'].status, 'error');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /DAEMON_RESTARTED/);
  });
});
