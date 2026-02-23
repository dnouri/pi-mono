import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { assistantMsg, userMsg } from "./utilities.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const tsxCliPath = join(packageRoot, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const cliSourcePath = join(packageRoot, "src", "cli.ts");

const BASE_RPC_ARGS = ["--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"];
const RPC_RESPONSE_TIMEOUT_MS = 10000;

interface RpcResponseEnvelope {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

interface SendRpcCommandOptions {
	extraArgs?: string[];
	cwd?: string;
}

function createPersistedSession(sessionRoot: string): string {
	const manager = SessionManager.create(sessionRoot, sessionRoot);
	manager.appendMessage(userMsg("hello"));
	manager.appendMessage(assistantMsg("hi"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		throw new Error("Expected persisted session file path");
	}
	return sessionFile;
}

async function sendRpcCommand(
	command: Record<string, unknown>,
	options: SendRpcCommandOptions = {},
): Promise<RpcResponseEnvelope> {
	return new Promise((resolve, reject) => {
		const rpcProcess = spawn("node", [tsxCliPath, cliSourcePath, ...BASE_RPC_ARGS, ...(options.extraArgs ?? [])], {
			cwd: options.cwd ?? packageRoot,
			env: {
				...process.env,
				ANTHROPIC_API_KEY: "test-anthropic-key",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		const rl = readline.createInterface({
			input: rpcProcess.stdout!,
			terminal: false,
		});

		let stderr = "";
		rpcProcess.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		let settled = false;
		const commandId = String(command.id ?? "req-1");

		const cleanup = () => {
			clearTimeout(timeout);
			rl.close();
		};

		const timeout = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			rpcProcess.kill("SIGTERM");
			reject(new Error(`Timed out waiting for response ${commandId}. Stderr: ${stderr}`));
		}, RPC_RESPONSE_TIMEOUT_MS);

		rpcProcess.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(error);
		});

		rpcProcess.on("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(new Error(`RPC process exited before response (code=${code}, signal=${signal}). Stderr: ${stderr}`));
		});

		rl.on("line", (line) => {
			if (settled) {
				return;
			}

			try {
				const message = JSON.parse(line) as RpcResponseEnvelope;
				if (message.type !== "response") {
					return;
				}

				const isCorrelatedResponse = message.id === commandId;
				const isUncorrelatedCommandError =
					message.id === undefined && message.command === command.type && message.success === false;
				if (!isCorrelatedResponse && !isUncorrelatedCommandError) {
					return;
				}

				settled = true;
				cleanup();
				rpcProcess.kill("SIGTERM");
				resolve(message);
			} catch {
				// Ignore non-JSON lines.
			}
		});

		rpcProcess.stdin?.write(`${JSON.stringify(command)}\n`);
		rpcProcess.stdin?.end();
	});
}

describe("RPC session mutation Option A contract", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	test("rename_session accepts relative valid session paths", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-session-mutation-"));
		tempDirs.push(tempRoot);

		const sessionRoot = join(tempRoot, "sessions");
		const sessionFile = createPersistedSession(sessionRoot);
		const relativePath = relative(tempRoot, sessionFile);

		const response = await sendRpcCommand(
			{ id: "req-1", type: "rename_session", sessionPath: relativePath, name: "renamed-session" },
			{ cwd: tempRoot },
		);

		expect(response.command).toBe("rename_session");
		expect(response.success).toBe(true);
		expect(SessionManager.open(sessionFile).getSessionName()).toBe("renamed-session");
	});

	test("rename_session rejects non-session file targets", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-session-mutation-"));
		tempDirs.push(tempRoot);

		const notesPath = join(tempRoot, "notes.txt");
		writeFileSync(notesPath, "NOT A SESSION\n", "utf8");

		const response = await sendRpcCommand({
			id: "req-1",
			type: "rename_session",
			sessionPath: notesPath,
			name: "renamed-session",
		});

		expect(response.command).toBe("rename_session");
		expect(response.success).toBe(false);
		expect(response.error).toContain(".jsonl");
		expect(readFileSync(notesPath, "utf8")).toBe("NOT A SESSION\n");
	});

	test("rename_session rejects .jsonl files without session headers", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-session-mutation-"));
		tempDirs.push(tempRoot);

		const malformedSessionPath = join(tempRoot, "malformed.jsonl");
		writeFileSync(malformedSessionPath, '{"type":"message","id":"abc"}\n', "utf8");

		const response = await sendRpcCommand({
			id: "req-1",
			type: "rename_session",
			sessionPath: malformedSessionPath,
			name: "renamed-session",
		});

		expect(response.command).toBe("rename_session");
		expect(response.success).toBe(false);
		expect(response.error).toContain("valid pi session");
	});

	test("delete_session rejects deleting the currently active session", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-session-mutation-"));
		tempDirs.push(tempRoot);

		const sessionRoot = join(tempRoot, "sessions");
		const activeSession = createPersistedSession(sessionRoot);

		const response = await sendRpcCommand(
			{ id: "req-1", type: "delete_session", sessionPath: activeSession },
			{ extraArgs: ["--session", activeSession] },
		);

		expect(response.command).toBe("delete_session");
		expect(response.success).toBe(false);
		expect(response.error).toContain("currently active");
		expect(existsSync(activeSession)).toBe(true);
	});

	test("delete_session accepts relative paths for non-active targets", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-session-mutation-"));
		tempDirs.push(tempRoot);

		const sessionRoot = join(tempRoot, "sessions");
		const activeSession = createPersistedSession(sessionRoot);
		const targetSession = createPersistedSession(sessionRoot);
		const relativeTarget = relative(tempRoot, targetSession);

		const response = await sendRpcCommand(
			{ id: "req-1", type: "delete_session", sessionPath: relativeTarget },
			{ cwd: tempRoot, extraArgs: ["--session", activeSession] },
		);

		expect(response.command).toBe("delete_session");
		expect(response.success).toBe(true);
		expect(existsSync(targetSession)).toBe(false);
		expect(existsSync(activeSession)).toBe(true);
	});

	test("unknown command errors preserve request id for correlation", async () => {
		const response = await sendRpcCommand({ id: "req-unknown", type: "unknown_command_for_contract" });

		expect(response.command).toBe("unknown_command_for_contract");
		expect(response.success).toBe(false);
		expect(response.id).toBe("req-unknown");
		expect(response.error).toContain("Unknown command");
	});
});
