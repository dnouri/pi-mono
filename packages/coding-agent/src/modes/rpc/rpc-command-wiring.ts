import { dirname } from "node:path";
import type { SessionInfo } from "../../core/session-manager.js";
import type { RpcCommand, RpcNavigateTreeResult, RpcSessionListItem } from "./rpc-types.js";

type ListSessionsScope = Extract<RpcCommand, { type: "list_sessions" }>["scope"];

interface SessionHeaderLike {
	cwd: string;
}

interface SessionScopeSource {
	getHeader(): SessionHeaderLike | null;
	getCwd(): string;
	getSessionDir(): string | undefined;
}

interface NavigateTreeSummaryEntryLike {
	id: string;
	summary: string;
	fromHook?: boolean;
}

export interface NavigateTreeResultLike {
	cancelled: boolean;
	aborted?: boolean;
	editorText?: string;
	summaryEntry?: NavigateTreeSummaryEntryLike;
}

export interface RpcListSessionsContext {
	sessionManager: SessionScopeSource;
	sessionFile: string | undefined;
}

export interface RpcListSessionsTarget {
	listAll: boolean;
	cwd: string;
	sessionDir: string | undefined;
}

/** Resolve list_sessions target semantics across current/all scopes. */
export function resolveListSessionsTarget(
	session: RpcListSessionsContext,
	scope: ListSessionsScope,
): RpcListSessionsTarget {
	if (scope === "all") {
		return {
			listAll: true,
			cwd: session.sessionManager.getCwd(),
			sessionDir: undefined,
		};
	}

	const headerCwd = session.sessionManager.getHeader()?.cwd;
	if (headerCwd && session.sessionFile) {
		return {
			listAll: false,
			cwd: headerCwd,
			sessionDir: dirname(session.sessionFile),
		};
	}

	return {
		listAll: false,
		cwd: session.sessionManager.getCwd(),
		sessionDir: session.sessionManager.getSessionDir(),
	};
}

/** Convert SessionInfo to RPC transport shape. */
export function toRpcSessionListItem(sessionInfo: SessionInfo, includeSearchText: boolean): RpcSessionListItem {
	return {
		path: sessionInfo.path,
		id: sessionInfo.id,
		cwd: sessionInfo.cwd,
		name: sessionInfo.name,
		parentSessionPath: sessionInfo.parentSessionPath,
		created: sessionInfo.created.toISOString(),
		modified: sessionInfo.modified.toISOString(),
		messageCount: sessionInfo.messageCount,
		firstMessage: sessionInfo.firstMessage,
		...(includeSearchText ? { allMessagesText: sessionInfo.allMessagesText } : {}),
	};
}

/** Convert navigateTree core result to RPC transport shape. */
export function toRpcNavigateTreeResult(result: NavigateTreeResultLike): RpcNavigateTreeResult {
	return {
		cancelled: result.cancelled,
		aborted: result.aborted,
		editorText: result.editorText,
		summaryEntry: result.summaryEntry
			? {
					id: result.summaryEntry.id,
					summary: result.summaryEntry.summary,
					fromExtension: result.summaryEntry.fromHook === true,
				}
			: undefined,
	};
}
