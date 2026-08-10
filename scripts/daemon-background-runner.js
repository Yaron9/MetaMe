'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { runAsyncCommand, createPlatformSpawn, terminateChildProcess } = require('./core/handoff');
const { COMPLETION_SCHEMA, normalizeCompletionResult } = require('./core/completion-contract');
const { resolveEnginePlugin } = require('./daemon-engine-runtime');

function collectNativeResult(enginePlugin, output) {
  const plugin = resolveEnginePlugin(
    enginePlugin,
    enginePlugin && enginePlugin.descriptor && enginePlugin.descriptor.id
  );
  const runtimeAdapter = plugin.runtime;
  let sessionId = '';
  let usage = null;
  let finalValue = null;
  let classifiedError = null;
  let toolUseCount = 0;
  let terminalType = '';
  for (const line of String(output || '').split('\n').filter(Boolean)) {
    for (const event of runtimeAdapter.parseEvent(line)) {
      if (terminalType) continue;
      if (event.type === 'session_observed' && event.nativeSessionId) {
        sessionId = event.nativeSessionId;
      }
      if (event.type === 'message_delta') finalValue = event.text;
      if (event.type === 'usage_observed') usage = event.usage || usage;
      if (event.type === 'run_completed') {
        terminalType = 'completed';
        usage = event.usage || usage;
        finalValue = event.raw && (event.raw.structured_output || event.raw.structuredOutput)
          || event.result
          || finalValue;
      }
      if (event.type === 'run_failed') {
        terminalType = 'failed';
        classifiedError = event;
      }
      if (event.type === 'tool_started') toolUseCount += 1;
    }
  }
  return { sessionId, usage, finalValue, classifiedError, toolUseCount };
}

function createBackgroundRunner(deps = {}) {
  if (typeof deps.getEngineRuntime !== 'function') {
    throw new TypeError('createBackgroundRunner requires getEngineRuntime');
  }
  const runCommand = deps.runCommand || runAsyncCommand;
  const fsModule = deps.fs || fs;
  const osModule = deps.os || os;
  const pathModule = deps.path || path;
  const spawnProcess = deps.spawn || createPlatformSpawn({
    fs: fsModule,
    path: pathModule,
    spawn,
    execSync,
  }).spawn;
  const activeChildren = new Set();

  async function runAdapterTurn(enginePlugin, request) {
    const plugin = resolveEnginePlugin(enginePlugin, request.turn && request.turn.engine);
    const runtime = plugin.runtime;
    const turn = request.turn || {};
    const candidateSession = request.nativeSession || {};
    const sessionWasValid = runtime.validateSession(candidateSession);
    const nativeSession = sessionWasValid ? candidateSession : null;
    const invocation = runtime.buildInvocation({ ...turn, session: nativeSession });
    const executionResult = await request.executionPolicy.execute(invocation);
    const result = executionResult || {};
    const events = [];
    for (const event of result.events || []) events.push(event);
    for (const line of result.nativeLines || []) {
      for (const event of runtime.parseEvent(line)) events.push(event);
    }
    let sessionId = result.sessionId || '';
    for (let index = events.length - 1; index >= 0 && !sessionId; index -= 1) {
      const event = events[index];
      if (event.type === 'session_observed') {
        sessionId = event.nativeSessionId || '';
      }
    }
    const failure = result.failure || (result.error ? runtime.classifyFailure(result.error) : null);
    const nativeSessionNext = runtime.updateSession(nativeSession, {
      sessionId,
      cwd: invocation.cwd,
      result,
      events,
    });
    return {
      ...result,
      events,
      sessionId,
      failure,
      nativeSession: nativeSessionNext,
      sessionWasValid,
    };
  }

  async function startTurn(options = {}) {
    const plugin = resolveEnginePlugin(deps.getEngineRuntime(options.engine), options.engine);
    const runtime = plugin.runtime;
    const engineName = plugin.descriptor.id;
    const runtimeCapability = plugin.descriptor.capabilities.runtime;
    if (!runtime || (runtimeCapability && (runtimeCapability.supported === false || runtimeCapability.state === 'unsupported'))) {
      return { ok: false, error: `${engineName}_runtime_unsupported`, errorCode: 'CAPABILITY_UNSUPPORTED' };
    }
    const timeouts = runtime.timeouts || {};
    const structuredOutput = runtime.structuredOutput || {};
    if (typeof runtime.isReady === 'function' && !runtime.isReady()) {
      return { ok: false, error: `${engineName}_runtime_not_ready`, errorCode: 'RUNTIME_NOT_READY' };
    }
    const structured = options.structured !== false;
    const schema = structured ? (options.outputSchema || COMPLETION_SCHEMA) : null;
    let schemaDir = '';
    let outputSchemaPath = '';
    let childRef = null;
    try {
      if (schema && structuredOutput.schema === 'path') {
        schemaDir = fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'metame-schema-'));
        outputSchemaPath = pathModule.join(schemaDir, 'completion.schema.json');
        fsModule.writeFileSync(outputSchemaPath, JSON.stringify(schema), { mode: 0o600 });
      }
      const turn = {
        input: String(options.prompt || ''),
        model: options.model || runtime.defaultModel,
        readOnly: !!options.readOnly,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs || timeouts.idleMs || 600000,
        daemonCfg: options.daemonCfg || {},
        permissionProfile: options.permissions || null,
        outputSchema: structuredOutput.schema === 'inline' ? schema : null,
        outputSchemaPath,
        outputFormat: structuredOutput.format || '',
        allowedTools: options.allowedTools || [],
        mcpConfig: options.mcpConfig || '',
        metameProject: options.projectKey || '',
        metameSenderId: options.senderId || '',
        providerEnv: options.providerEnv || {},
        internalPrompt: !!options.internalPrompt,
      };
      const commandResult = await runAdapterTurn(plugin, {
        turn,
        nativeSession: options.sessionRef || {},
        executionPolicy: {
          execute: invocation => runCommand({
            spawn: spawnProcess,
            cmd: invocation.executable,
            args: invocation.args,
            cwd: invocation.cwd,
            env: invocation.env,
            input: invocation.input,
            timeoutMs: options.timeoutMs || timeouts.idleMs || 600000,
            killSignal: invocation.killSignal || runtime.killSignal || 'SIGTERM',
            useProcessGroup: process.platform !== 'win32',
            signal: options.signal || null,
            // The runtime declares whether structured output requires tail
            // retention; truncation is rejected below so no mode can silently
            // validate partial output.
            stdoutBufferMode: structured
              ? (structuredOutput.buffer || 'tail')
              : (structuredOutput.unstructuredBuffer || 'prefix'),
            onChild(child) {
              childRef = child;
              activeChildren.add(child);
            },
          }),
        },
      });
      if (childRef) activeChildren.delete(childRef);
      if (commandResult.error) {
        if (commandResult.errorCode === 'INTERRUPTED') {
          return { ok: false, error: commandResult.error, errorCode: 'INTERRUPTED' };
        }
        const timedOut = /^Timeout:/i.test(commandResult.error);
        const classified = timedOut ? null : runtime.classifyFailure(commandResult.error);
        return {
          ok: false,
          error: commandResult.error,
          errorCode: timedOut ? 'TIMEOUT' : (classified ? classified.code : 'EXEC_FAILURE'),
        };
      }
      if (structured && commandResult.stdoutTruncated) {
        return {
          ok: false,
          error: 'structured_output_truncated',
          errorCode: 'BUFFER_LIMIT_EXCEEDED',
        };
      }
      let native = collectNativeResult(plugin, commandResult.output);
      if (!structured && typeof runtime.recoverFinalOutput === 'function') {
        native = runtime.recoverFinalOutput(commandResult.output, native);
      }
      if (native.classifiedError) {
        return { ok: false, error: native.classifiedError.message, errorCode: native.classifiedError.code };
      }
      if (options.forbidTools && native.toolUseCount > 0) {
        return {
          ok: false,
          error: 'background_tool_use_forbidden',
          errorCode: 'BACKGROUND_TOOL_USE_FORBIDDEN',
        };
      }
      if (!structured && !String(native.finalValue || '').trim()) {
        return { ok: false, error: 'empty_final_reply', errorCode: 'EMPTY_FINAL_REPLY' };
      }
      const normalized = structured ? normalizeCompletionResult(native.finalValue) : native.finalValue;
      return {
        ok: true,
        result: normalized,
        output: structured ? JSON.stringify(normalized) : String(normalized || ''),
        sessionId: native.sessionId,
        usage: native.usage,
      };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const isContractError = message.startsWith('completion_');
      const isSessionMismatch = message.endsWith('_native_session_mismatch');
      const classified = isContractError ? null : runtime.classifyFailure(err);
      return {
        ok: false,
        error: message,
        errorCode: isContractError
          ? 'INVALID_STRUCTURED_OUTPUT'
          : isSessionMismatch
            ? 'NATIVE_SESSION_MISMATCH'
            : (classified ? classified.code : 'EXEC_FAILURE'),
      };
    } finally {
      if (childRef) activeChildren.delete(childRef);
      if (schemaDir) {
        try { fsModule.rmSync(schemaDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }

  function shutdown(signal = 'SIGKILL') {
    for (const child of activeChildren) terminateChildProcess(child, signal, { useProcessGroup: true });
    activeChildren.clear();
  }

  return { startTurn, shutdown };
}

module.exports = { createBackgroundRunner, _internal: { collectNativeResult } };
