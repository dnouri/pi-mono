import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	resolveListSessionsTarget,
	toRpcNavigateTreeResult,
	toRpcSessionListItem,
} from "../src/modes/rpc/rpc-command-wiring.js";
import { assistantMsg, createTestSession, type TestSessionContext, userMsg } from "./utilities.js";

interface SessionScopeFixture {
	workspaceRoot: string;
	projectA: string;
	projectB: string;
	sessionDirA: string;
	sessionDirB: string;
	sessionFileA: string;
	sessionFileB: string;
	ctx: TestSessionContext;
}

function createPersistedSession(
	cwd: string,
	sessionDir: string,
	prefix: string,
): { manager: SessionManager; file: string } {
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage(userMsg(`${prefix} user`));
	manager.appendMessage(assistantMsg(`${prefix} assistant`));

	const file = manager.getSessionFile();
	if (!file) {
		throw new Error("Expected persisted session file path");
	}

	return { manager, file };
}

function createFixture(): SessionScopeFixture {
	const workspaceRoot = join(tmpdir(), `pi-rpc-current-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const projectA = join(workspaceRoot, "project-a");
	const projectB = join(workspaceRoot, "project-b");
	const sessionDirA = join(workspaceRoot, "sessions-a");
	const sessionDirB = join(workspaceRoot, "sessions-b");

	const { manager: sessionManagerA, file: sessionFileA } = createPersistedSession(projectA, sessionDirA, "A");
	const { file: sessionFileB } = createPersistedSession(projectB, sessionDirB, "B");
	const ctx = createTestSession({ sessionManager: sessionManagerA, cwd: projectA });

	return {
		workspaceRoot,
		projectA,
		projectB,
		sessionDirA,
		sessionDirB,
		sessionFileA,
		sessionFileB,
		ctx,
	};
}

describe("RPC list_sessions current scope semantics", () => {
	let fixture: SessionScopeFixture;

	beforeEach(() => {
		fixture = createFixture();
	});

	afterEach(() => {
		fixture.ctx.cleanup();
		if (existsSync(fixture.workspaceRoot)) {
			rmSync(fixture.workspaceRoot, { recursive: true });
		}
	});

	test("scope: current follows switched session context in RPC resolver", async () => {
		const session = fixture.ctx.session;

		const listCurrent = async (): Promise<string[]> => {
			const target = resolveListSessionsTarget(session, "current");
			expect(target.listAll).toBe(false);
			const sessions = await SessionManager.list(target.cwd, target.sessionDir);
			return sessions.map((s) => s.path);
		};

		const startupCwd = session.sessionManager.getCwd();
		const startupSessionDir = session.sessionManager.getSessionDir();

		const beforeSwitchTarget = resolveListSessionsTarget(session, "current");
		expect(beforeSwitchTarget.cwd).toBe(fixture.projectA);
		expect(beforeSwitchTarget.sessionDir).toBe(fixture.sessionDirA);

		const beforeSwitch = await listCurrent();
		expect(beforeSwitch).toContain(fixture.sessionFileA);
		expect(beforeSwitch).not.toContain(fixture.sessionFileB);

		const switched = await session.switchSession(fixture.sessionFileB);
		expect(switched).toBe(true);
		expect(session.sessionManager.getSessionFile()).toBe(fixture.sessionFileB);
		expect(session.sessionManager.getHeader()?.cwd).toBe(fixture.projectB);

		// Core SessionManager context remains startup-bound after switch_session.
		// The RPC resolver compensates by reading from the active session header.
		expect(session.sessionManager.getCwd()).toBe(startupCwd);
		expect(session.sessionManager.getSessionDir()).toBe(startupSessionDir);

		const afterSwitchTarget = resolveListSessionsTarget(session, "current");
		expect(afterSwitchTarget.cwd).toBe(fixture.projectB);
		expect(afterSwitchTarget.sessionDir).toBe(fixture.sessionDirB);

		const afterSwitch = await listCurrent();
		expect(afterSwitch).toContain(fixture.sessionFileB);
		expect(afterSwitch).not.toContain(fixture.sessionFileA);
	});

	test("scope: all uses global listing target", () => {
		const target = resolveListSessionsTarget(fixture.ctx.session, "all");
		expect(target.listAll).toBe(true);
		expect(target.cwd).toBe(fixture.ctx.session.sessionManager.getCwd());
		expect(target.sessionDir).toBeUndefined();
	});

	test("undefined scope defaults to current-session targeting", () => {
		const target = resolveListSessionsTarget(fixture.ctx.session, undefined);
		expect(target.listAll).toBe(false);
		expect(target.cwd).toBe(fixture.projectA);
		expect(target.sessionDir).toBe(fixture.sessionDirA);
	});

	test("falls back to SessionManager context when session file is unavailable", () => {
		const fallbackSessionManager = SessionManager.inMemory("/fallback-cwd");
		const fallbackCtx = createTestSession({ sessionManager: fallbackSessionManager, cwd: "/fallback-cwd" });

		const target = resolveListSessionsTarget(fallbackCtx.session, "current");
		expect(target.cwd).toBe(fallbackSessionManager.getCwd());
		expect(target.sessionDir).toBe(fallbackSessionManager.getSessionDir());
		expect(target.listAll).toBe(false);

		fallbackCtx.cleanup();
	});

	test("falls back to SessionManager context when header cwd is unavailable", () => {
		const fallbackSessionManager = SessionManager.create(fixture.projectA, fixture.sessionDirA);
		const fakeSession = {
			sessionManager: {
				getHeader: () => null,
				getCwd: () => fallbackSessionManager.getCwd(),
				getSessionDir: () => fallbackSessionManager.getSessionDir(),
			},
			sessionFile: "/tmp/example/session.jsonl",
		};

		const target = resolveListSessionsTarget(fakeSession, "current");
		expect(target.cwd).toBe(fallbackSessionManager.getCwd());
		expect(target.sessionDir).toBe(fallbackSessionManager.getSessionDir());
		expect(target.listAll).toBe(false);
	});
});

describe("toRpcSessionListItem", () => {
	const sample: SessionInfo = {
		path: "/tmp/s.jsonl",
		id: "session-id",
		cwd: "/tmp",
		name: "sample",
		parentSessionPath: "/tmp/parent.jsonl",
		created: new Date("2026-01-01T00:00:00.000Z"),
		modified: new Date("2026-01-01T00:01:00.000Z"),
		messageCount: 3,
		firstMessage: "hello",
		allMessagesText: "hello world",
	};

	test("omits search text unless requested", () => {
		const item = toRpcSessionListItem(sample, false);
		expect(item.allMessagesText).toBeUndefined();
	});

	test("includes search text when requested", () => {
		const item = toRpcSessionListItem(sample, true);
		expect(item.allMessagesText).toBe("hello world");
	});

	test("maps core fields and ISO timestamps", () => {
		const item = toRpcSessionListItem(sample, false);
		expect(item.path).toBe(sample.path);
		expect(item.id).toBe(sample.id);
		expect(item.cwd).toBe(sample.cwd);
		expect(item.name).toBe(sample.name);
		expect(item.parentSessionPath).toBe(sample.parentSessionPath);
		expect(item.messageCount).toBe(sample.messageCount);
		expect(item.firstMessage).toBe(sample.firstMessage);
		expect(item.created).toBe(sample.created.toISOString());
		expect(item.modified).toBe(sample.modified.toISOString());
	});
});

describe("toRpcNavigateTreeResult", () => {
	test("maps extension summary metadata to response shape", () => {
		const mapped = toRpcNavigateTreeResult({
			cancelled: false,
			editorText: "draft",
			summaryEntry: {
				id: "entry-1",
				summary: "summary text",
				fromHook: true,
			},
		});

		expect(mapped.summaryEntry?.fromExtension).toBe(true);
		expect(mapped.editorText).toBe("draft");
	});

	test("maps missing fromHook to false for backward-compatible clients", () => {
		const mapped = toRpcNavigateTreeResult({
			cancelled: false,
			summaryEntry: {
				id: "entry-2",
				summary: "summary text",
			},
		});

		expect(mapped.summaryEntry?.fromExtension).toBe(false);
	});

	test("keeps summaryEntry undefined when not provided", () => {
		const mapped = toRpcNavigateTreeResult({ cancelled: false, aborted: true });
		expect(mapped.summaryEntry).toBeUndefined();
		expect(mapped.aborted).toBe(true);
	});
});
