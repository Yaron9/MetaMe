'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { runAsyncCommand, createPlatformSpawn, terminateChildProcess } = require('./core/handoff');
const { COMPLETION_SCHEMA, normalizeCompletionResult } = require('./core/completion-contract');

function collectNativeResult(runtime, output) {
  let sessionId = '';
  let usage = null;
  let finalValue = null;
  let classifiedError = null;
  let toolUseCount = 0;
  for (const line of String(output || '').split('\n').filter(Boolean)) {
    for (const event of runtime.parseStreamEvent(line)) {
      if (event.type === 'session') sessionId = event.sessionId || sessionId;
      if (event.type === 'text') finalValue = event.text;
      if (event.type === 'done') {
        usage = event.usage || usage;
        finalValue = event.raw && (event.raw.structured_output || event.raw.structuredOutput)
          || event.result
          || finalValue;
      }
      if (event.type === 'error') classifiedError = event;
      if (event.type === 'tool_use') toolUseCount += 1;
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

  function runAdapterTurn(runtime, request) {
    if (typeof runtime.runTurn === 'function') return runtime.runTurn(request);
    const turn = request.turn || {};
    const session = request.nativeSession || {};
    return request.executionPolicy.execute({
      engine: runtime.name,
      binary: runtime.binary,
      args: runtime.buildArgs({ ...turn, session }),
      env: runtime.buildEnv({ ...turn, session }),
      input: turn.input,
      cwd: turn.cwd,
      killSignal: runtime.killSignal,
      timeouts: runtime.timeouts,
    });
  }

  async function startTurn(options = {}) {
    const runtime = deps.getEngineRuntime(options.engine);
    if (typeof runtime.isReady === 'function' && !runtime.isReady()) {
      return { ok: false, error: `${runtime.name}_runtime_not_ready`, errorCode: 'RUNTIME_NOT_READY' };
    }
    const structured = options.structured !== false;
    const schema = structured ? (options.outputSchema || COMPLETION_SCHEMA) : null;
    let schemaDir = '';
    let outputSchemaPath = '';
    let childRef = null;
    try {
      if (runtime.name === 'codex' && schema) {
        schemaDir = fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'metame-schema-'));
        outputSchemaPath = pathModule.join(schemaDir, 'completion.schema.json');
        fsModule.writeFileSync(outputSchemaPath, JSON.stringify(schema), { mode: 0o600 });
      }
      const turn = {
        input: String(options.prompt || ''),
        model: options.model || runtime.defaultModel,
        readOnly: !!options.readOnly,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs || runtime.timeouts.idleMs,
        daemonCfg: options.daemonCfg || {},
        permissionProfile: options.permissions || null,
        outputSchema: runtime.name === 'claude' ? schema : null,
        outputSchemaPath,
        outputFormat: runtime.name === 'claude' ? 'json' : '',
        allowedTools: options.allowedTools || [],
        mcpConfig: options.mcpConfig || '',
        metameProject: options.projectKey || '',
        metameSenderId: options.senderId || '',
        providerEnv: options.providerEnv || {},
        internalPrompt: !!options.internalPrompt,
      };
      const commandResult = await runAdapterTurn(runtime, {
        turn,
        nativeSession: options.sessionRef || {},
        executionPolicy: {
          execute: invocation => runCommand({
            spawn: spawnProcess,
            cmd: invocation.binary,
            args: invocation.args,
            cwd: invocation.cwd,
            env: invocation.env,
            input: invocation.input,
            timeoutMs: options.timeoutMs || runtime.timeouts.idleMs,
            killSignal: runtime.killSignal,
            useProcessGroup: process.platform !== 'win32',
            signal: options.signal || null,
            // Structured/Codex JSONL keeps the tail where the final native event lives.
            // Legacy Claude text keeps its historical prefix preview. Structured truncation
            // is rejected below, so neither mode can silently validate partial output.
            stdoutBufferMode: structured || runtime.name === 'codex' ? 'tail' : 'prefix',
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
        const classified = timedOut ? null : runtime.classifyError(commandResult.error);
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
      let native = collectNativeResult(runtime, commandResult.output);
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
      const classified = isContractError ? null : deps.getEngineRuntime(options.engine).classifyError(err);
      return {
        ok: false,
        error: message,
        errorCode: isContractError ? 'INVALID_STRUCTURED_OUTPUT' : (classified ? classified.code : 'EXEC_FAILURE'),
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
