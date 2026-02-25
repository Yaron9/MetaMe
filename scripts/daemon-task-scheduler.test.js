'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _private } = require('./daemon-task-scheduler');

const {
  parseAtTime,
  parseDays,
  nextClockRunAfter,
  buildTaskSchedule,
  computeInitialNextRun,
  nextRunAfter,
} = _private;

function nextDayOfWeek(base, day) {
  const d = new Date(base);
  while (d.getDay() !== day) d.setDate(d.getDate() + 1);
  return d;
}

describe('daemon-task-scheduler private helpers', () => {
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
