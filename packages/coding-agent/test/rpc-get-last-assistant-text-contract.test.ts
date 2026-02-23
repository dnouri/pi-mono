import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { assistantMsg } from "./utilities.js";

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
}

async function sendRpcCommand(
	command: Record<string, unknown>,
	extraArgs: string[] = [],
): Promise<RpcResponseEnvelope> {
	return new Promise((resolve, reject) => {
		const rpcProcess = spawn("node", [tsxCliPath, cliSourcePath, ...BASE_RPC_ARGS, ...extraArgs], {
			cwd: packageRoot,
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
				if (message.type === "response" && message.id === commandId) {
					settled = true;
					cleanup();
					rpcProcess.kill("SIGTERM");
					resolve(message);
				}
			} catch {
				// Ignore non-JSON lines.
			}
		});

		rpcProcess.stdin?.write(`${JSON.stringify(command)}\n`);
		rpcProcess.stdin?.end();
	});
}

describe("RPC get_last_assistant_text contract", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	test("returns explicit null when no assistant message exists", async () => {
		const response = await sendRpcCommand({ id: "req-1", type: "get_last_assistant_text" }, ["--no-session"]);

		expect(response.command).toBe("get_last_assistant_text");
		expect(response.success).toBe(true);
		expect(response.data).toBeDefined();
		expect(Object.hasOwn(response.data!, "text")).toBe(true);
		expect(response.data?.text).toBeNull();
	});

	test("returns assistant text when the current session already has assistant messages", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-last-text-"));
		tempDirs.push(tempRoot);

		const sessionDir = join(tempRoot, "sessions");
		const sessionManager = SessionManager.create(tempRoot, sessionDir);
		sessionManager.appendMessage(assistantMsg("from-session"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file path");
		}

		const response = await sendRpcCommand({ id: "req-1", type: "get_last_assistant_text" }, [
			"--session",
			sessionFile,
		]);

		expect(response.command).toBe("get_last_assistant_text");
		expect(response.success).toBe(true);
		expect(response.data?.text).toBe("from-session");
	});
});
