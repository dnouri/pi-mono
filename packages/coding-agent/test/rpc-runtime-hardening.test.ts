import { describe, expect, test } from "vitest";
import { parseRpcInputLine } from "../src/modes/rpc/rpc-command-validation.js";
import { settleFireAndForgetStart } from "../src/modes/rpc/rpc-fire-and-forget.js";

describe("parseRpcInputLine", () => {
	test("rejects prompt payloads without message", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ id: "bad-prompt", type: "prompt" }));

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-prompt",
				command: "prompt",
				message: 'Invalid command payload for "prompt": "message" must be a string',
			},
		});
	});

	test("rejects prompt payloads when images is not an array", () => {
		const parsed = parseRpcInputLine(
			JSON.stringify({ id: "bad-images", type: "prompt", message: "hello", images: "not-an-array" }),
		);

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-images",
				command: "prompt",
				message: 'Invalid command payload for "prompt": "images" must be an array of ImageContent objects',
			},
		});
	});

	test("rejects follow_up payloads with invalid image content blocks", () => {
		const parsed = parseRpcInputLine(
			JSON.stringify({
				id: "bad-follow-up-image",
				type: "follow_up",
				message: "hello",
				images: [{ type: "image", data: "abc" }],
			}),
		);

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-follow-up-image",
				command: "follow_up",
				message:
					'Invalid command payload for "follow_up": "images[0]" must be an object with type "image", string "data", and string "mimeType"',
			},
		});
	});

	test("rejects list_sessions payloads with invalid scope", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ id: "bad-scope", type: "list_sessions", scope: "workspace" }));

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-scope",
				command: "list_sessions",
				message: 'Invalid command payload for "list_sessions": "scope" must be "current" or "all"',
			},
		});
	});

	test("rejects rename_session payloads with relative sessionPath", () => {
		const parsed = parseRpcInputLine(
			JSON.stringify({ id: "bad-rename-path", type: "rename_session", sessionPath: "./session.jsonl", name: "x" }),
		);

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-rename-path",
				command: "rename_session",
				message: 'Invalid command payload for "rename_session": "sessionPath" must be an absolute path',
			},
		});
	});

	test("rejects delete_session payloads with relative sessionPath", () => {
		const parsed = parseRpcInputLine(
			JSON.stringify({ id: "bad-delete-path", type: "delete_session", sessionPath: "./session.jsonl" }),
		);

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-delete-path",
				command: "delete_session",
				message: 'Invalid command payload for "delete_session": "sessionPath" must be an absolute path',
			},
		});
	});

	test("rejects non-string command ids", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ id: 42, type: "get_state" }));

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: undefined,
				command: "get_state",
				message: 'Invalid command payload for "get_state": "id" must be a string',
			},
		});
	});

	test("rejects non-object payloads", () => {
		const parsed = parseRpcInputLine("123");

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: undefined,
				command: "parse",
				message: "Invalid command payload: expected a JSON object",
			},
		});
	});

	test("returns parse error when JSON decoding fails", () => {
		const parsed = parseRpcInputLine('{"type":');

		expect(parsed).toMatchObject({ kind: "error", error: { command: "parse" } });
		expect((parsed as { kind: "error"; error: { message: string } }).error.message).toContain(
			"Failed to parse command:",
		);
	});

	test("rejects extension_ui_response payloads without id", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ type: "extension_ui_response", cancelled: true }));

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: undefined,
				command: "extension_ui_response",
				message: 'Invalid extension UI response: "id" must be a string',
			},
		});
	});

	test("rejects bash payloads without command", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ id: "bad-bash", type: "bash" }));

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-bash",
				command: "bash",
				message: 'Invalid command payload for "bash": "command" must be a string',
			},
		});
	});

	test("rejects unknown thinking levels", () => {
		const parsed = parseRpcInputLine(
			JSON.stringify({ id: "bad-level", type: "set_thinking_level", level: "extreme" }),
		);

		expect(parsed).toEqual({
			kind: "error",
			error: {
				id: "bad-level",
				command: "set_thinking_level",
				message:
					'Invalid command payload for "set_thinking_level": "level" must be "off", "minimal", "low", "medium", "high", or "xhigh"',
			},
		});
	});

	test("accepts valid extension_ui_response payloads", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ type: "extension_ui_response", id: "ui-1", cancelled: true }));

		expect(parsed).toEqual({
			kind: "extension_ui_response",
			response: { type: "extension_ui_response", id: "ui-1", cancelled: true },
		});
	});

	test("accepts valid commands", () => {
		const parsed = parseRpcInputLine(JSON.stringify({ id: "ok", type: "get_state" }));

		expect(parsed).toEqual({
			kind: "command",
			command: { id: "ok", type: "get_state" },
		});
	});
});

describe("settleFireAndForgetStart", () => {
	test("returns rejected for immediate failures", async () => {
		const rejected = Promise.reject(new Error("boom"));
		const outcome = await settleFireAndForgetStart(rejected, (cause) =>
			cause instanceof Error ? cause.message : String(cause),
		);

		expect(outcome).toEqual({ status: "rejected", error: "boom" });
	});

	test("returns resolved for immediate completion", async () => {
		const resolved = Promise.resolve();
		const outcome = await settleFireAndForgetStart(resolved, (cause) =>
			cause instanceof Error ? cause.message : String(cause),
		);

		expect(outcome).toEqual({ status: "resolved" });
	});

	test("returns pending for long-running operations", async () => {
		let resolvePromise: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});

		const outcome = await settleFireAndForgetStart(pending, (cause) =>
			cause instanceof Error ? cause.message : String(cause),
		);

		expect(outcome).toEqual({ status: "pending" });
		resolvePromise?.();
		await pending;
	});
});
