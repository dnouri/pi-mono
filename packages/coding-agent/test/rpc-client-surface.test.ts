import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.js";

function successResponse(command: string, data?: unknown): RpcResponse {
	if (data === undefined) {
		return { type: "response", command, success: true } as RpcResponse;
	}
	return { type: "response", command, success: true, data } as RpcResponse;
}

describe("RpcClient surface", () => {
	test("prompt accepts options object with streamingBehavior", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send: (command: unknown) => Promise<RpcResponse> }).send = async (command: unknown) => {
			sent.push(command);
			return successResponse("prompt");
		};

		await (
			client as unknown as {
				prompt: (message: string, options: { streamingBehavior: "steer" | "followUp" }) => Promise<void>;
			}
		).prompt("refine answer", { streamingBehavior: "followUp" });

		expect(sent).toEqual([{ type: "prompt", message: "refine answer", streamingBehavior: "followUp" }]);
	});

	test("listSessions accepts options object", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send: (command: unknown) => Promise<RpcResponse> }).send = async (command: unknown) => {
			sent.push(command);
			return successResponse("list_sessions", { sessions: [] });
		};

		await (
			client as unknown as {
				listSessions: (options: { scope: "current" | "all"; includeSearchText: boolean }) => Promise<unknown>;
			}
		).listSessions({ scope: "all", includeSearchText: true });

		expect(sent).toEqual([{ type: "list_sessions", scope: "all", includeSearchText: true }]);
	});

	test("promptAndWait accepts options object with timeout", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];

		(client as unknown as { send: (command: unknown) => Promise<RpcResponse> }).send = async (command: unknown) => {
			sent.push(command);
			return successResponse("prompt");
		};
		(client as unknown as { collectEvents: (timeout: number) => Promise<unknown> }).collectEvents = async (
			timeout: number,
		) => {
			expect(timeout).toBe(1234);
			return [];
		};

		await (
			client as unknown as {
				promptAndWait: (
					message: string,
					options: { streamingBehavior: "steer" | "followUp" },
					timeout: number,
				) => Promise<unknown>;
			}
		).promptAndWait("follow-up", { streamingBehavior: "steer" }, 1234);

		expect(sent).toEqual([{ type: "prompt", message: "follow-up", streamingBehavior: "steer" }]);
	});

	test("exposes session mutation command helpers", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send: (command: unknown) => Promise<RpcResponse> }).send = async (command: unknown) => {
			sent.push(command);
			const commandType = (command as { type: string }).type;
			return successResponse(commandType);
		};

		await (
			client as unknown as {
				renameSession: (sessionPath: string, name: string) => Promise<void>;
			}
		).renameSession("/tmp/session-a.jsonl", "renamed");

		await (
			client as unknown as {
				deleteSession: (sessionPath: string) => Promise<void>;
			}
		).deleteSession("/tmp/session-a.jsonl");

		expect(sent).toEqual([
			{ type: "rename_session", sessionPath: "/tmp/session-a.jsonl", name: "renamed" },
			{ type: "delete_session", sessionPath: "/tmp/session-a.jsonl" },
		]);
	});

	test("rejects pending requests immediately when RPC process exits", async () => {
		const client = new RpcClient();
		const fakeProcess = Object.assign(new EventEmitter(), {
			stdin: { write: vi.fn() },
		}) as unknown as {
			stdin: { write: (line: string) => void };
			emit: (event: "exit", code: number | null, signal: NodeJS.Signals | null) => boolean;
		};

		(client as unknown as { process: unknown }).process = fakeProcess;

		const sendPromise = (
			client as unknown as {
				send: (command: { type: "get_state" }) => Promise<RpcResponse>;
			}
		).send({ type: "get_state" });

		fakeProcess.emit("exit", 9, null);

		const outcome = await Promise.race([
			sendPromise
				.then(() => "resolved" as const)
				.catch((error: unknown) => {
					expect(error).toBeInstanceOf(Error);
					return "rejected" as const;
				}),
			new Promise<"pending">((resolve) => {
				setTimeout(() => resolve("pending"), 20);
			}),
		]);

		expect(outcome).toBe("rejected");
	});

	test("onEvent only emits AgentEvent envelopes", () => {
		const client = new RpcClient();
		const received: unknown[] = [];
		client.onEvent((event) => received.push(event));

		(client as unknown as { handleLine: (line: string) => void }).handleLine(
			JSON.stringify({ type: "response", command: "prompt", success: false, error: "background failure" }),
		);
		(client as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({ type: "agent_start" }));

		expect(received).toEqual([{ type: "agent_start" }]);
	});

	test("onProtocolMessage emits uncorrelated response envelopes", () => {
		const client = new RpcClient();
		const received: unknown[] = [];
		client.onProtocolMessage((message) => received.push(message));

		(client as unknown as { handleLine: (line: string) => void }).handleLine(
			JSON.stringify({ type: "response", command: "prompt", success: false, error: "background failure" }),
		);
		(client as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({ type: "agent_start" }));

		expect(received).toEqual([
			{ type: "response", command: "prompt", success: false, error: "background failure" },
			{ type: "agent_start" },
		]);
	});
});
