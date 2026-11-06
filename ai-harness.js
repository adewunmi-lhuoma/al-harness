function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(signal?.reason ? String(signal.reason) : "Operation aborted");
}

function serialize(value, label) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
}

async function invokeWithTimeout(operation, { signal, timeoutMs, label }) {
  if (signal?.aborted) {
    throw abortError(signal);
  }

  const controller = new AbortController();
  let timeoutId;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (error) => {
    if (!controller.signal.aborted) {
      controller.abort(error);
      rejectAbort(error);
    }
  };
  const onParentAbort = () => abort(abortError(signal));

  signal?.addEventListener("abort", onParentAbort, { once: true });
  timeoutId = setTimeout(() => {
    const error = new Error(`${label} timed out after ${timeoutMs}ms`);
    error.code = "TIMEOUT";
    abort(error);
  }, timeoutMs);

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      abortPromise
    ]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createHarness({
  model,
  tools = {},
  maxSteps = 8,
  maxToolCalls = 12,
  maxRetries = 2,
  retryDelayMs = 250,
  maxRetryDelayMs = 5000,
  retryJitter = 0.2,
  runTimeoutMs = 120000,
  modelTimeoutMs = 30000,
  toolTimeoutMs = 30000,
  shouldRetry = (error) => error?.retryable === true || error?.code === "TIMEOUT",
  onEvent = () => {}
}) {
  if (typeof model !== "function") {
    throw new TypeError("model must be a function");
  }

  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new TypeError("tools must be an object");
  }

  for (const [name, value] of Object.entries({ maxSteps, maxToolCalls, maxRetries })) {
    if (!Number.isInteger(value) || value < 0 || (name !== "maxRetries" && value < 1)) {
      throw new RangeError(`${name} must be a valid non-negative integer`);
    }
  }

  positiveNumber(retryDelayMs, "retryDelayMs");
  positiveNumber(maxRetryDelayMs, "maxRetryDelayMs");
  positiveNumber(runTimeoutMs, "runTimeoutMs");
  positiveNumber(modelTimeoutMs, "modelTimeoutMs");
  positiveNumber(toolTimeoutMs, "toolTimeoutMs");

  if (!Number.isFinite(retryJitter) || retryJitter < 0 || retryJitter > 1) {
    throw new RangeError("retryJitter must be between 0 and 1");
  }
  if (typeof shouldRetry !== "function" || typeof onEvent !== "function") {
    throw new TypeError("shouldRetry and onEvent must be functions");
  }

  const entries = Object.entries(tools);
  for (const [name, tool] of entries) {
    if (!name || typeof tool?.execute !== "function") {
      throw new TypeError(`Tool "${name}" must provide an execute function`);
    }
  }

  const toolDescriptions = entries.map(([name, tool]) => ({
    name,
    description: tool.description ?? "",
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema })
  }));

  return async function run(prompt, { signal } = {}) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new TypeError("prompt must be a non-empty string");
    }

    const messages = [{ role: "user", content: prompt }];
    const startedAt = Date.now();
    let toolCallCount = 0;

    const emit = (event) => {
      try {
        const result = onEvent({ ...event, timestamp: new Date().toISOString() });
        if (result && typeof result.then === "function") {
          result.catch(() => {});
        }
      } catch {}
    };

    return invokeWithTimeout(async (runSignal) => {
      emit({ type: "run_started" });

      try {
        for (let step = 1; step <= maxSteps; step += 1) {
          let response;
          for (let attempt = 0; ; attempt += 1) {
            try {
              response = await invokeWithTimeout(
                (callSignal) => model({
                  messages: messages.map((message) => ({ ...message })),
                  tools: toolDescriptions.map((tool) => ({ ...tool })),
                  signal: callSignal,
                  step
                }),
                { signal: runSignal, timeoutMs: modelTimeoutMs, label: "Model call" }
              );
              break;
            } catch (error) {
              if (attempt >= maxRetries || !shouldRetry(error)) {
                throw error;
              }

              const backoff = Math.min(retryDelayMs * (2 ** attempt), maxRetryDelayMs);
              const waitMs = backoff * (1 - retryJitter + Math.random() * retryJitter * 2);
              emit({ type: "model_retry", step, attempt: attempt + 1, delayMs: Math.round(waitMs) });
              await delay(waitMs, runSignal);
            }
          }

          if (response?.type === "final" && typeof response.text === "string") {
            emit({ type: "run_completed", step, durationMs: Date.now() - startedAt });
            return response.text;
          }

          if (response?.type !== "tool_call" || typeof response.name !== "string") {
            throw new TypeError("Model must return a final response or a tool call");
          }

          if (!Object.hasOwn(tools, response.name)) {
            throw new Error(`Model requested an unknown tool: ${response.name}`);
          }
          if (toolCallCount >= maxToolCalls) {
            throw new Error(`Run exceeded the ${maxToolCalls}-tool-call limit`);
          }

          const args = response.arguments ?? {};
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw new TypeError(`Arguments for tool "${response.name}" must be an object`);
          }
          serialize(args, `Arguments for tool "${response.name}"`);

          messages.push({
            role: "assistant",
            content: serialize({
              type: "tool_call",
              name: response.name,
              arguments: args
            }, "Tool call")
          });

          toolCallCount += 1;
          const tool = tools[response.name];
          const toolStartedAt = Date.now();
          emit({ type: "tool_started", step, tool: response.name, toolCallCount });

          let result;
          try {
            result = await invokeWithTimeout(
              (toolSignal) => tool.execute(args, { signal: toolSignal }),
              { signal: runSignal, timeoutMs: toolTimeoutMs, label: `Tool "${response.name}"` }
            );
            messages.push({
              role: "tool",
              name: response.name,
              content: serialize(result, `Result from tool "${response.name}"`)
            });
            emit({
              type: "tool_completed",
              step,
              tool: response.name,
              durationMs: Date.now() - toolStartedAt
            });
          } catch (error) {
            if (runSignal.aborted) {
              throw abortError(runSignal);
            }
            const toolError = {
              error: error instanceof Error ? error.message : String(error),
              code: error?.code ?? "TOOL_ERROR"
            };
            messages.push({
              role: "tool",
              name: response.name,
              content: serialize(toolError, "Tool error")
            });
            emit({
              type: "tool_failed",
              step,
              tool: response.name,
              durationMs: Date.now() - toolStartedAt,
              code: toolError.code
            });
          }
        }

        throw new Error(`Run exceeded the ${maxSteps}-step limit`);
      } catch (error) {
        emit({
          type: runSignal.aborted ? "run_aborted" : "run_failed",
          durationMs: Date.now() - startedAt,
          code: error?.code ?? "RUN_ERROR"
        });
        throw error;
      }
    }, { signal, timeoutMs: runTimeoutMs, label: "Run" });
  };
}