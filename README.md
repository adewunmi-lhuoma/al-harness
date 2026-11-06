# AI Harness

A small, provider-neutral control loop for model calls and tools. The harness limits execution, handles transient model failures, forwards cancellation, and reports run events. You supply the model adapter and implement the tools.

## Requirements

Use Node.js 18 or newer. This file is an ES module; set `"type": "module"` in your `package.json` or use it from another ES-module project.

## Quick Start

```js
import { createHarness } from "./ai-harness.js";

const run = createHarness({
  model: async ({ messages, tools, signal, step }) => {
    if (step === 1) {
      return {
        type: "tool_call",
        name: "lookup",
        arguments: { id: "42" }
      };
    }

    const result = messages.findLast((message) => message.role === "tool");
    return { type: "final", text: `Lookup result: ${result.content}` };
  },
  tools: {
    lookup: {
      description: "Look up a record by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      execute: async ({ id }, { signal }) => ({ id, status: "ready" })
    }
  },
  onEvent: (event) => console.log(event.type)
});

const answer = await run("Check record 42");
console.log(answer);
```

The example uses a mock model so it runs without a provider SDK. Replace `model` with an adapter for your provider.

## Adapter Contract

The harness calls `model` with `{ messages, tools, signal, step }`. The adapter translates those values into the provider's request format and returns one of:

```js
{ type: "final", text: "The answer" }
{ type: "tool_call", name: "lookup", arguments: { id: "42" } }
```

Tool descriptions contain `name` and `description`, and include `inputSchema` when provided. The schema is passed to the adapter; the harness does not validate arguments against it.

Each tool has an `execute(args, { signal })` function. Its result must be JSON serializable. If execution throws, the error message is returned to the model as a tool result, allowing it to recover. Model and tool functions should honor the supplied `AbortSignal` when possible.

## Configuration

| Option | Default | Description |
| --- | ---: | --- |
| `maxSteps` | `8` | Maximum model responses in one run. |
| `maxToolCalls` | `12` | Maximum tool executions in one run. |
| `maxRetries` | `2` | Retries for model errors accepted by `shouldRetry`. |
| `retryDelayMs` | `250` | Base delay for exponential backoff. |
| `maxRetryDelayMs` | `5000` | Maximum backoff delay. |
| `retryJitter` | `0.2` | Randomized backoff fraction from `0` to `1`. |
| `runTimeoutMs` | `120000` | Total run timeout. |
| `modelTimeoutMs` | `30000` | Timeout for each model call. |
| `toolTimeoutMs` | `30000` | Timeout for each tool call. |
| `shouldRetry(error)` | Timeout errors and `error.retryable === true` | Decides whether a model error can be retried. |
| `onEvent(event)` | No-op | Receives lifecycle events; callback errors do not fail the run. |

Call `run(prompt, { signal })` to start a run. It resolves to the final response text. The harness emits `run_started`, `model_retry`, `tool_started`, `tool_completed`, `tool_failed`, and either `run_completed`, `run_failed`, or `run_aborted` events.

## Security Notes

Tools are executable application code. Validate arguments and enforce authorization inside each tool before accessing data or performing side effects. The model-provided schema is guidance for the provider adapter, not a security boundary. Keep credentials in your application environment and avoid returning secrets in tool results or error messages.