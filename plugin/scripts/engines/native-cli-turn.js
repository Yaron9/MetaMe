'use strict';

function collectNativeEvents(adapter, executionResult, onEvent) {
  const events = [];
  let terminalSeen = false;
  const emit = event => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'run_completed' || event.type === 'run_failed') {
      if (terminalSeen) return;
      terminalSeen = true;
    }
    events.push(event);
    if (typeof onEvent === 'function') onEvent(event);
  };

  for (const event of executionResult.events || []) emit(event);
  for (const line of executionResult.nativeLines || []) {
    for (const event of adapter.parseEvent(line)) emit(event);
  }
  return events;
}

function findObservedSessionId(events, executionResult) {
  if (executionResult.sessionId) return executionResult.sessionId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'session_observed' && events[index].nativeSessionId) {
      return events[index].nativeSessionId;
    }
  }
  return '';
}

function findFinalValue(events, executionResult) {
  if (executionResult.final !== undefined) return executionResult.final;
  if (executionResult.output !== undefined) return executionResult.output;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'run_completed' && event.result !== undefined) return event.result;
    if (event.type === 'message_delta' && event.text !== undefined) return event.text;
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
  const sessionWasValid = adapter.validateSession(candidateSession);
  const nativeSession = sessionWasValid ? candidateSession : null;
  const invocation = adapter.buildInvocation({ ...turn, session: nativeSession });

  let executionResult;
  try {
    executionResult = await execute(invocation);
  } catch (error) {
    const failure = adapter.classifyFailure(error);
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
  const eventFailure = events.find(event => event.type === 'run_failed') || null;
  const failure = normalizedResult.failure
    || (errorValue ? adapter.classifyFailure(errorValue) : null)
    || eventFailure;
  const nextNativeSession = adapter.updateSession(nativeSession, {
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
