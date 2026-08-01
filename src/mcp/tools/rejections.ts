/**
 * Make SDK-level argument rejections visible, and answerable.
 *
 * The SDK validates `tools/call` arguments against the registered input schema
 * *before* it invokes our callback, so a rejection never reaches
 * {@link runTool}. It does not surface as a thrown error either: the SDK
 * catches its own `McpError` and returns an `isError` result carrying the
 * message. The caller is therefore told what was wrong — but the server records
 * nothing.
 *
 * That silence is the problem. Every other failure here emits an `mcp.*` event,
 * so an operator reading the logs sees a tool call that produced no success and
 * no failure, which is indistinguishable from one that hung. A
 * `contentType: "text/markdown"` rejection was diagnosed as a timeout for
 * exactly this reason, and the message that would have explained it in one line
 * was only visible in the proxy's log.
 *
 * So this wraps the SDK's handler to log the rejection, and to re-render it with
 * the same remediation line every other failure gets — the SDK's own text stops
 * at what was wrong and never says what to do about it. Both matter downstream:
 * mcpo turns an `isError` result into a 500, and Open WebUI shows the model
 * nothing, so the clearer the text the better its chances of self-correcting.
 *
 * The SDK exposes no way to read back a handler it registered, so the original
 * is taken from a private field. If that ever disappears the hook declines to
 * install and says so, rather than throwing at startup — the server still works,
 * it just loses this improvement.
 */
import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ValidationError } from '../../errors.js';
import { logAppError } from '../../logger.js';
import { formatToolError, toolErrorResult, type ToolDeps, type ToolExtra } from './shared.js';

/** Shape of one entry in the SDK's private handler map. */
type CallToolHandler = (
  request: { params: { name?: string } },
  extra: ToolExtra,
) => Promise<CallToolResult>;

/**
 * Only input validation is converted. Output-validation failures and "tool not
 * found" also raise InvalidParams, but those are our bug or a genuine protocol
 * error respectively, and a client is right to see them as such.
 */
const INPUT_REJECTION = 'Input validation error:';

export function installInputRejectionHandler(server: McpServer, deps: ToolDeps): void {
  // The SDK offers setRequestHandler/removeRequestHandler but no getter, so the
  // handler it registered can only be read from the map behind them.
  const internals = server.server as unknown as {
    _requestHandlers?: Map<string, CallToolHandler>;
  };
  const original = internals._requestHandlers?.get('tools/call');

  if (!original) {
    deps.logger.warn(
      { event: 'mcp.rejection_hook_unavailable' },
      'could not wrap the SDK tools/call handler; argument rejections will not be logged',
    );
    return;
  }

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await original(request, extra);

    // The SDK does not throw this at us: it catches its own McpError and hands
    // back an isError result carrying the message. So the model was never left
    // with nothing — but nothing was logged either, which is why a rejected
    // call looks identical to a hung one from the server's side.
    if (result.isError !== true) return result;

    const text = firstText(result);
    if (!text.includes(INPUT_REJECTION)) return result;

    const toolName = typeof request.params.name === 'string' ? request.params.name : 'unknown';
    const requestId = randomUUID();

    // A ValidationError so this logs at warn as a caller fault, and picks up the
    // same "correct the arguments and call again" remediation every other
    // failure returns. The SDK's own text stops at what was wrong.
    const appError = new ValidationError(text);
    logAppError(deps.logger, appError, `MCP tool ${toolName} arguments rejected`, {
      event: 'mcp.tool_rejected',
      tool: toolName,
      requestId,
    });

    return toolErrorResult(formatToolError(toolName, appError, requestId, deps.config));
  });
}

/** The text of the first text block, or empty string when there is none. */
function firstText(result: CallToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}
