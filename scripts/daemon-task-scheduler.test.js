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
  nextRunAfter,
  resolveTaskEngine,
} = _private;

function nextDayOfWeek(base, day) {
  const d = new Date(base);
  while (d.getDay() !== day) d.setDate(d.getDate() + 1);
  return d;
}

describe('daemon-task-scheduler private helpers', () => {
  it('allows explicit agy only for enabled scoped project tasks', () => {
    const task = { engine: 'agy', _project: { key: 'munger' } };
    const enabled = {
      daemon: { experimental_engines: { agy: { enabled: true, allowed_projects: ['munger'] } } },
      projects: { munger: { fallback_engine: 'codex' } },
    };
    assert.equal(resolveTaskEngine(task, enabled).engine, 'agy');
    assert.equal(resolveTaskEngine(task, { projects: enabled.projects }).engine, 'codex');
  });
  it('inherits the daemon engine when a task and project do not override it', () => {
    assert.equal(resolveTaskEngine({ name: 'memory-extract' }, {}, 'codex').engine, 'codex');
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
    assert.equal(calls[0].env.METAME_INTERNAL_PROMPT, '1');
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
  });
});
