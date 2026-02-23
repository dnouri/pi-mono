import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
	isRpcAgentEvent,
	RpcClient,
	type RpcEventEnvelope,
	type RpcEventListener,
} from "../src/modes/rpc/rpc-client.js";

describe("RpcClient type contract", () => {
	test("RpcEventListener receives protocol envelope union", () => {
		const listener: RpcEventListener = (event) => {
			expectTypeOf(event).toEqualTypeOf<RpcEventEnvelope>();
		};

		expect(listener).toBeTypeOf("function");
	});

	test("onEvent callback payload is typed as RpcEventEnvelope", () => {
		const client = new RpcClient();
		const unsubscribe = client.onEvent((event) => {
			expectTypeOf(event).toEqualTypeOf<RpcEventEnvelope>();
		});

		expect(unsubscribe).toBeTypeOf("function");
	});

	test("isRpcAgentEvent narrows protocol envelope to AgentEvent", () => {
		const envelope = { type: "agent_start" } as RpcEventEnvelope;
		if (!isRpcAgentEvent(envelope)) {
			throw new Error("Expected agent_start to be classified as AgentEvent");
		}

		expectTypeOf(envelope).toEqualTypeOf<AgentEvent>();
		expect(envelope.type).toBe("agent_start");
	});

	test("isRpcAgentEvent returns false for extension UI envelopes", () => {
		const envelope = {
			type: "extension_ui_request",
			id: "ui-1",
			method: "notify",
			message: "hello",
		} as RpcEventEnvelope;

		expect(isRpcAgentEvent(envelope)).toBe(false);
	});

	test("RpcEventEnvelope includes non-correlated response envelopes", () => {
		const envelope = {
			type: "response",
			command: "parse",
			success: false,
			error: "synthetic parse envelope",
		} satisfies RpcEventEnvelope;

		expect(envelope.command).toBe("parse");
	});
});
