/**
 * Lightweight projection of SessionTreeNode to RpcTreeNode for RPC transport.
 *
 * Filters metadata entries (label, session_info, custom), resolves tool call info
 * from assistant messages, and produces compact nodes with preview text.
 */

import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { formatToolCall } from "../../core/format-tool-call.js";
import type { BashExecutionMessage } from "../../core/messages.js";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.js";
import type { RpcTreeNode, RpcTreeNodeBase } from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/** Base fields for a projected node before adding the role-specific `type`. */
type ProjectedBase = Omit<RpcTreeNodeBase, "type">;

/** Resolved tool call info, keyed by toolCallId */
export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

/** A content block with a type discriminant; text blocks carry a `.text` string. */
interface ContentBlock {
	type: string;
	text?: string;
}

/** Content shapes accepted by {@link extractText}. */
type ExtractableContent = string | readonly ContentBlock[] | null | undefined;

type FilteredMetadataEntry = Extract<SessionEntry, { type: "label" | "session_info" | "custom" }>;
type ProjectableNonMessageEntry = Exclude<SessionEntry, FilteredMetadataEntry | { type: "message" }>;
type RpcMessageRole = Extract<RpcTreeNode, { type: "message" }>["role"];

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract text from message content, optionally truncated.
 * Handles string content and content block arrays (only "text" blocks -
 * images, tool calls, and thinking blocks have no textual preview).
 */
export function extractText(content: ExtractableContent, maxLen?: number): string {
	if (typeof content === "string") return maxLen !== undefined ? content.slice(0, maxLen) : content;
	if (Array.isArray(content)) {
		let result = "";
		for (const c of content) {
			if (c.type === "text" && c.text) {
				result += c.text;
				if (maxLen !== undefined && result.length >= maxLen) return result.slice(0, maxLen);
			}
		}
		return result;
	}
	return "";
}

/** Normalize text for single-line preview display: replace newlines/tabs with spaces, trim. */
function normalizePreview(text: string): string {
	return text.replace(/[\n\t]/g, " ").trim();
}

/** Return `{ content }` when `include` is true, empty object otherwise. Reduces spread boilerplate. */
function optionalContent(include: boolean, content: string): { content?: string } {
	return include ? { content } : {};
}

/**
 * Map message roles to the RPC contract role union.
 * Unknown declaration-merged roles are projected as "custom" to keep wire compatibility.
 */
function toRpcMessageRole(role: string): RpcMessageRole {
	switch (role) {
		case "user":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return role;
		default:
			return "custom";
	}
}

/**
 * Build a map from toolCallId to {name, arguments} by scanning tree nodes
 * for assistant messages with toolCall content blocks.
 */
export function buildToolCallMap(roots: SessionTreeNode[]): Map<string, ToolCallInfo> {
	const map = new Map<string, ToolCallInfo>();

	function visit(node: SessionTreeNode): void {
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const { content } = entry.message as AssistantMessage;
			for (const block of content) {
				if (block.type === "toolCall") {
					map.set(block.id, { name: block.name, arguments: block.arguments });
				}
			}
		}
		for (const child of node.children) visit(child);
	}

	for (const root of roots) visit(root);
	return map;
}

/**
 * Project a SessionTreeNode tree into RpcTreeNode tree.
 *
 * Filters out label, session_info, and custom entries (metadata only).
 * Labels are already resolved onto target nodes via node.label.
 */
export function projectTree(
	roots: SessionTreeNode[],
	toolCallMap: Map<string, ToolCallInfo>,
	includeContent: boolean,
): RpcTreeNode[] {
	return roots.flatMap((node) => projectNode(node, toolCallMap, includeContent, null));
}

// ============================================================================
// Internal helpers
// ============================================================================

function isFilteredMetadataEntry(entry: SessionEntry): entry is FilteredMetadataEntry {
	return entry.type === "label" || entry.type === "session_info" || entry.type === "custom";
}

function projectNode(
	node: SessionTreeNode,
	toolCallMap: Map<string, ToolCallInfo>,
	includeContent: boolean,
	projectedParentId: string | null,
): RpcTreeNode[] {
	const entry = node.entry;
	if (isFilteredMetadataEntry(entry)) {
		return projectChildren(node.children, toolCallMap, includeContent, projectedParentId);
	}

	const children = projectChildren(node.children, toolCallMap, includeContent, entry.id);
	const base: ProjectedBase = {
		id: entry.id,
		parentId: projectedParentId,
		timestamp: entry.timestamp,
		label: node.label,
		children,
	};

	if (entry.type === "message") {
		return [projectMessage(base, entry.message, toolCallMap, includeContent)];
	}

	return [projectNonMessageEntry(base, entry, includeContent)];
}

function projectMessage(
	base: ProjectedBase,
	message: Extract<SessionEntry, { type: "message" }>["message"],
	toolCallMap: Map<string, ToolCallInfo>,
	includeContent: boolean,
): RpcTreeNode {
	if (message.role === "toolResult") {
		return projectToolResult(base, message, toolCallMap, includeContent);
	}

	if (message.role === "bashExecution") {
		const bash = message as BashExecutionMessage;
		const command = normalizePreview(bash.command);
		return {
			...base,
			type: "message",
			role: "bashExecution",
			preview: `[bash]: ${command}`,
			...optionalContent(includeContent, bash.output),
		};
	}

	if (message.role === "assistant") {
		return projectAssistant(base, message, includeContent);
	}

	const content = "content" in message ? (message.content as ExtractableContent) : undefined;
	return {
		...base,
		type: "message",
		// After toolResult/bashExecution/assistant are handled above, remaining
		// roles are expected to be user/custom summaries. Unknown declaration-merged
		// roles are normalized to "custom" for RPC contract stability.
		role: toRpcMessageRole(message.role),
		preview: normalizePreview(extractText(content, 200)),
		...optionalContent(includeContent, extractText(content)),
	};
}

function projectNonMessageEntry(
	base: ProjectedBase,
	entry: ProjectableNonMessageEntry,
	includeContent: boolean,
): RpcTreeNode {
	switch (entry.type) {
		case "compaction":
			return { ...base, type: "compaction", tokensBefore: entry.tokensBefore };
		case "model_change":
			return { ...base, type: "model_change", provider: entry.provider, modelId: entry.modelId };
		case "thinking_level_change":
			return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
		case "branch_summary":
			return { ...base, type: "branch_summary", summary: entry.summary };
		case "custom_message":
			return {
				...base,
				type: "custom_message",
				customType: entry.customType,
				preview: normalizePreview(extractText(entry.content, 200)),
				...optionalContent(includeContent, extractText(entry.content)),
			};
	}
}

function projectChildren(
	nodes: SessionTreeNode[],
	toolCallMap: Map<string, ToolCallInfo>,
	includeContent: boolean,
	projectedParentId: string | null,
): RpcTreeNode[] {
	return nodes.flatMap((child) => projectNode(child, toolCallMap, includeContent, projectedParentId));
}

function projectAssistant(base: ProjectedBase, message: AssistantMessage, includeContent: boolean): RpcTreeNode {
	const text = extractText(message.content, 200);
	const preview = text
		? normalizePreview(text)
		: message.stopReason === "aborted"
			? "(aborted)"
			: message.errorMessage
				? normalizePreview(message.errorMessage)
				: "(no content)";

	return {
		...base,
		type: "message",
		role: "assistant",
		preview,
		...optionalContent(includeContent, extractText(message.content)),
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	};
}

function projectToolResult(
	base: ProjectedBase,
	message: ToolResultMessage,
	toolCallMap: Map<string, ToolCallInfo>,
	includeContent: boolean,
): RpcTreeNode {
	const toolCall = message.toolCallId ? toolCallMap.get(message.toolCallId) : undefined;
	const formatted = toolCall ? formatToolCall(toolCall.name, toolCall.arguments) : undefined;

	return {
		...base,
		type: "tool_result",
		toolName: toolCall?.name ?? message.toolName,
		toolArgs: toolCall?.arguments,
		formattedToolCall: formatted,
		preview: normalizePreview(formatted ?? `[${message.toolName ?? "tool"}]`),
		...optionalContent(includeContent, extractText(message.content)),
	};
}
