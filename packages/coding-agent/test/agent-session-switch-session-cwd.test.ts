import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const originalCwd = process.cwd();

function createTempRoot(): string {
	const root = join(tmpdir(), `agent-session-switch-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

function writeSessionFile(sessionDir: string, cwd: string, id: string): string {
	mkdirSync(sessionDir, { recursive: true });
	const sessionPath = join(sessionDir, `${id}.jsonl`);
	writeFileSync(
		sessionPath,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
	return sessionPath;
}

function createSession(sessionManager: SessionManager, cwd: string): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
		}),
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
		cwd,
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: createTestResourceLoader(),
	});
}

async function readRelativeFile(session: AgentSession, path: string): Promise<string> {
	const readTool = session.state.tools.find((tool) => tool.name === "read");
	if (!readTool) {
		throw new Error("Expected read tool to be active");
	}

	const result = await readTool.execute("test-read", { path });
	const textBlock = result.content.find((block) => block.type === "text");
	if (!textBlock || textBlock.type !== "text") {
		throw new Error("Expected read tool to return text content");
	}
	return textBlock.text;
}

afterEach(() => {
	process.chdir(originalCwd);
});

describe("AgentSession session cwd synchronization", () => {
	it("updates SessionManager cwd when loading a session from another project", () => {
		const root = createTempRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const sessionDirA = join(root, "sessions-a");
		const sessionDirB = join(root, "sessions-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });

		try {
			const targetSessionPath = writeSessionFile(sessionDirB, projectB, "target-session");
			const sessionManager = SessionManager.create(projectA, sessionDirA);

			sessionManager.setSessionFile(targetSessionPath);

			expect(sessionManager.getCwd()).toBe(projectB);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an explicit session directory when switching projects", () => {
		const root = createTempRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const explicitSessionDir = join(root, "shared-sessions");
		const targetSessionDir = join(root, "sessions-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		mkdirSync(explicitSessionDir, { recursive: true });

		try {
			const targetSessionPath = writeSessionFile(targetSessionDir, projectB, "target-session");
			const sessionManager = SessionManager.create(projectA, explicitSessionDir);

			sessionManager.setSessionFile(targetSessionPath);

			expect(sessionManager.getSessionDir()).toBe(explicitSessionDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rebuilds tools against the target session cwd after switching sessions", async () => {
		const root = createTempRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const sessionDirA = join(root, "sessions-a");
		const sessionDirB = join(root, "sessions-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		writeFileSync(join(projectA, "note.txt"), "from-project-a");
		writeFileSync(join(projectB, "note.txt"), "from-project-b");

		let session: AgentSession | undefined;
		try {
			const targetSessionPath = writeSessionFile(sessionDirB, projectB, "target-session");
			const sessionManager = SessionManager.create(projectA, sessionDirA);
			session = createSession(sessionManager, projectA);

			await session.switchSession(targetSessionPath);

			expect(await readRelativeFile(session, "note.txt")).toContain("from-project-b");
			expect(process.cwd()).toBe(projectB);
		} finally {
			session?.dispose();
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers the session manager cwd when constructed around an existing session", async () => {
		const root = createTempRoot();
		const launchDir = join(root, "launch-dir");
		const projectB = join(root, "project-b");
		const sessionDirB = join(root, "sessions-b");
		mkdirSync(launchDir, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		writeFileSync(join(projectB, "note.txt"), "from-project-b");

		let session: AgentSession | undefined;
		try {
			const targetSessionPath = writeSessionFile(sessionDirB, projectB, "target-session");
			const sessionManager = SessionManager.open(targetSessionPath);
			session = createSession(sessionManager, launchDir);

			expect(await readRelativeFile(session, "note.txt")).toContain("from-project-b");
			expect(process.cwd()).toBe(projectB);
		} finally {
			session?.dispose();
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
