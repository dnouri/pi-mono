import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

function writeFakeRpcCliScript(tempDir: string): string {
	const cliPath = join(tempDir, "fake-rpc-cli.cjs");
	const script = [
		'const readline = require("node:readline");',
		"const rl = readline.createInterface({ input: process.stdin, terminal: false });",
		'const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
		"const state = {",
		'  thinkingLevel: "medium",',
		"  isStreaming: false,",
		"  isCompacting: false,",
		'  steeringMode: "all",',
		'  followUpMode: "one-at-a-time",',
		'  sessionId: "fake-session",',
		"  autoCompactionEnabled: false,",
		"  messageCount: 0,",
		"  pendingMessageCount: 0,",
		"};",
		"",
		'rl.on("line", (line) => {',
		"  const command = JSON.parse(line);",
		'  if (command.type === "get_state") {',
		'    emit({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "hello" });',
		'    emit({ type: "response", command: "parse", success: false, error: "synthetic parse envelope" });',
		'    emit({ type: "response", id: command.id, command: "get_state", success: true, data: state });',
		"    return;",
		"  }",
		'  if (command.type === "prompt") {',
		'    emit({ type: "response", id: command.id, command: "prompt", success: true });',
		'    emit({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "from-prompt" });',
		'    emit({ type: "response", command: "parse", success: false, error: "prompt parse envelope" });',
		'    emit({ type: "agent_start" });',
		'    emit({ type: "agent_end", messages: [] });',
		"    return;",
		"  }",
		'  emit({ type: "response", id: command.id, command: command.type, success: true });',
		"});",
	].join("\n");

	writeFileSync(cliPath, script, "utf8");
	return cliPath;
}

async function collectOnEventEnvelopes(tempDirs: string[]): Promise<Array<Record<string, unknown>>> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-rpc-client-surface-"));
	tempDirs.push(tempDir);

	const client = new RpcClient({
		cliPath: writeFakeRpcCliScript(tempDir),
	});

	const envelopes: Array<Record<string, unknown>> = [];
	client.onEvent((event) => {
		envelopes.push(event as unknown as Record<string, unknown>);
	});

	await client.start();
	try {
		await client.getState();
	} finally {
		await client.stop();
	}

	return envelopes;
}

async function collectPromptAndWaitEventTypes(tempDirs: string[]): Promise<string[]> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-rpc-client-surface-"));
	tempDirs.push(tempDir);

	const client = new RpcClient({
		cliPath: writeFakeRpcCliScript(tempDir),
	});

	await client.start();
	try {
		const events = await client.promptAndWait("hello", undefined, 2000);
		return events.map((event) => event.type);
	} finally {
		await client.stop();
	}
}

describe("RpcClient onEvent compatibility", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	test("keeps extension_ui_request envelopes observable via onEvent", async () => {
		const envelopes = await collectOnEventEnvelopes(tempDirs);

		expect(envelopes).toContainEqual(
			expect.objectContaining({
				type: "extension_ui_request",
				method: "notify",
			}),
		);
	});

	test("keeps non-correlated response envelopes observable via onEvent", async () => {
		const envelopes = await collectOnEventEnvelopes(tempDirs);

		expect(envelopes).toContainEqual(
			expect.objectContaining({
				type: "response",
				command: "parse",
				success: false,
			}),
		);
	});

	test("does not forward correlated responses to onEvent listeners", async () => {
		const envelopes = await collectOnEventEnvelopes(tempDirs);

		expect(envelopes).not.toContainEqual(
			expect.objectContaining({
				type: "response",
				command: "get_state",
				success: true,
			}),
		);
	});

	test("promptAndWait returns only agent events", async () => {
		const eventTypes = await collectPromptAndWaitEventTypes(tempDirs);

		expect(eventTypes).toEqual(["agent_start", "agent_end"]);
	});
});
