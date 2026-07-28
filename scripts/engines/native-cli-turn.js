'use strict';

function collectNativeEvents(adapter, executionResult, onEvent) {
  const events = [];
  const emit = event => {
    if (!event || typeof event !== 'object') return;
    events.push(event);
    if (typeof onEvent === 'function') onEvent(event);
  };

  for (const event of executionResult.events || []) emit(event);
  for (const line of executionResult.nativeLines || []) {
    for (const event of adapter.parseStreamEvent(line)) emit(event);
  }
  return events;
}

function findObservedSessionId(events, executionResult) {
  if (executionResult.sessionId) return executionResult.sessionId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'session' && events[index].sessionId) {
      return events[index].sessionId;
    }
  }
  return '';
}

function findFinalValue(events, executionResult) {
  if (executionResult.final !== undefined) return executionResult.final;
  if (executionResult.output !== undefined) return executionResult.output;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'done' && event.result !== undefined) return event.result;
    if (event.type === 'text' && event.text !== undefined) return event.text;
  }
  return null;
}

async function executeNativeCliTurn(adapter, request = {}) {
  const turn = request.turn || {};
  const executionPolicy = request.executionPolicy || {};
  const execute = executionPolicy.execute;
  if (typeof execute !== 'function') {
    throw new TypeError(`native_cli_turn_executor_required:${adapter.name}`);
  }

  const candidateSession = request.nativeSession || null;
  if (!adapter.acceptsNativeSession(candidateSession)) {
    throw new Error(`${adapter.name}_native_session_mismatch`);
  }
  const sessionWasValid = adapter.validateNativeSession(candidateSession);
  const nativeSession = sessionWasValid ? candidateSession : null;
  const invocation = Object.freeze({
    engine: adapter.name,
    binary: adapter.binary,
    args: adapter.buildArgs({ ...turn, session: nativeSession }),
    env: adapter.buildEnv({ ...turn, session: nativeSession }),
    input: turn.input === undefined ? '' : turn.input,
    cwd: turn.cwd || (nativeSession && nativeSession.cwd) || '',
    killSignal: adapter.killSignal,
    timeouts: adapter.timeouts,
  });

  let executionResult;
  try {
    executionResult = await execute(invocation);
  } catch (error) {
    const failure = adapter.classifyError(error);
    return {
      events: [],
      final: null,
      failure,
      error: error && error.message ? error.message : String(error),
      nativeSession,
      sessionWasValid,
    };
  }

  const normalizedResult = executionResult || {};
  const events = collectNativeEvents(adapter, normalizedResult, request.onEvent);
  const sessionId = findObservedSessionId(events, normalizedResult);
  const errorValue = normalizedResult.error || '';
  const failure = normalizedResult.failure
    || (errorValue ? adapter.classifyError(errorValue) : null);
  const nextNativeSession = adapter.updateNativeSession(nativeSession, {
    sessionId,
    cwd: invocation.cwd,
    result: normalizedResult,
    events,
  });

  return {
    ...normalizedResult,
    events,
    final: findFinalValue(events, normalizedResult),
    failure,
    sessionId,
    nativeSession: nextNativeSession,
    sessionWasValid,
  };
}

module.exports = {
  executeNativeCliTurn,
};
