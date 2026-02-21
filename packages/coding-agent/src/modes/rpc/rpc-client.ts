/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	RpcCommand,
	RpcCommandByType,
	RpcExtensionUIRequest,
	RpcForkMessage,
	RpcGetTreeResult,
	RpcListSessionsResult,
	RpcNavigateTreeResult,
	RpcResponse,
	RpcSessionListItem,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcPromptOptions = Pick<RpcCommandByType<"prompt">, "images" | "streamingBehavior">;

export type RpcListSessionsOptions = Pick<RpcCommandByType<"list_sessions">, "scope" | "includeSearchText">;

export type RpcEventListener = (event: AgentEvent) => void;

export type RpcProtocolMessage = AgentEvent | RpcResponse | RpcExtensionUIRequest | Record<string, unknown>;

export type RpcProtocolListener = (message: RpcProtocolMessage) => void;

const AGENT_EVENT_TYPES: ReadonlySet<AgentEvent["type"]> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

type PromptInput = ImageContent[] | RpcPromptOptions | undefined;

function toPromptOptions(input: PromptInput): RpcPromptOptions {
	if (!input) {
		return {};
	}
	if (Array.isArray(input)) {
		return { images: input };
	}
	return input;
}

function toListSessionsOptions(
	scopeOrOptions?: "current" | "all" | RpcListSessionsOptions,
	includeSearchText?: boolean,
): RpcListSessionsOptions {
	if (!scopeOrOptions || typeof scopeOrOptions === "string") {
		return {
			scope: scopeOrOptions,
			includeSearchText,
		};
	}
	return scopeOrOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	return AGENT_EVENT_TYPES.has(value.type as AgentEvent["type"]);
}

function isPendingResponseEnvelope(value: unknown): value is RpcResponse & { id: string } {
	return isRecord(value) && value.type === "response" && typeof value.id === "string";
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private rl: readline.Interface | null = null;
	private eventListeners: RpcEventListener[] = [];
	private protocolListeners: RpcProtocolListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Collect stderr for debugging
		this.process.stderr?.on("data", (data) => {
			this.stderr += data.toString();
		});

		// Set up line reader for stdout
		this.rl = readline.createInterface({
			input: this.process.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.rl?.close();
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.rl = null;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 * Only AgentEvent envelopes are delivered here.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all decoded protocol messages that are not correlated responses.
	 * Includes AgentEvent, RpcResponse (without pending request id), extension UI requests,
	 * and extension_error envelopes.
	 */
	onProtocolMessage(listener: RpcProtocolListener): () => void {
		this.protocolListeners.push(listener);
		return () => {
			const index = this.protocolListeners.indexOf(listener);
			if (index !== -1) {
				this.protocolListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 *
	 * Overloads:
	 * - `prompt(message, images)` (legacy)
	 * - `prompt(message, { images, streamingBehavior })`
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void>;
	async prompt(message: string, options?: RpcPromptOptions): Promise<void>;
	async prompt(message: string, imagesOrOptions?: ImageContent[] | RpcPromptOptions): Promise<void> {
		const options = toPromptOptions(imagesOrOptions);
		await this.send({
			type: "prompt",
			message,
			images: options.images,
			streamingBehavior: options.streamingBehavior,
		});
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 * Each message includes its entry ID, text, and timestamp.
	 */
	async getForkMessages(): Promise<RpcForkMessage[]> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: RpcForkMessage[] }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 * Returns undefined when no assistant message exists yet.
	 */
	async getLastAssistantText(): Promise<string | undefined> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text?: string }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Rename any session by its file path.
	 */
	async renameSession(sessionPath: string, name: string): Promise<void> {
		await this.send({ type: "rename_session", sessionPath, name });
	}

	/**
	 * Delete any session by its file path.
	 */
	async deleteSession(sessionPath: string): Promise<void> {
		await this.send({ type: "delete_session", sessionPath });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get the session tree with lightweight projected nodes.
	 * @param includeContent When true, includes full text content alongside preview.
	 */
	async getTree(includeContent?: boolean): Promise<RpcGetTreeResult> {
		const response = await this.send({ type: "get_tree", includeContent });
		return this.getData(response);
	}

	/**
	 * Set or clear a label on a tree entry.
	 * @param entryId Entry to label.
	 * @param label Label text, or omit/empty to clear.
	 */
	async setLabel(entryId: string, label?: string): Promise<void> {
		await this.send({ type: "set_label", entryId, label });
	}

	/**
	 * Navigate to a different point in the session tree.
	 * @param targetId Entry ID to navigate to.
	 * @param options Navigation options (summarize, customInstructions, replaceInstructions, label).
	 */
	async navigateTree(
		targetId: string,
		options?: Omit<Extract<RpcCommand, { type: "navigate_tree" }>, "id" | "type" | "targetId">,
	): Promise<RpcNavigateTreeResult> {
		const response = await this.send({
			type: "navigate_tree",
			targetId,
			...options,
		});
		return this.getData(response);
	}

	/**
	 * List sessions for the current project or all projects.
	 * @param scope "current" (default) lists the active project's sessions; "all" lists cross-project.
	 * @param includeSearchText When true, includes allMessagesText for client-side search.
	 *
	 * Overloads:
	 * - `listSessions(scope?, includeSearchText?)` (legacy)
	 * - `listSessions({ scope, includeSearchText })`
	 */
	async listSessions(scope?: "current" | "all", includeSearchText?: boolean): Promise<RpcSessionListItem[]>;
	async listSessions(options?: RpcListSessionsOptions): Promise<RpcSessionListItem[]>;
	async listSessions(
		scopeOrOptions?: "current" | "all" | RpcListSessionsOptions,
		includeSearchText?: boolean,
	): Promise<RpcSessionListItem[]> {
		const options = toListSessionsOptions(scopeOrOptions, includeSearchText);
		const response = await this.send({
			type: "list_sessions",
			scope: options.scope,
			includeSearchText: options.includeSearchText,
		});
		return this.getData<RpcListSessionsResult>(response).sessions;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout?: number): Promise<AgentEvent[]>;
	async promptAndWait(message: string, options?: RpcPromptOptions, timeout?: number): Promise<AgentEvent[]>;
	async promptAndWait(
		message: string,
		imagesOrOptions?: ImageContent[] | RpcPromptOptions,
		timeout = 60000,
	): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, toPromptOptions(imagesOrOptions));
		return eventsPromise;
	}

	/**
	 * Write a raw JSON string to the process stdin.
	 * Bypasses typed command validation — use for testing edge cases
	 * like unknown commands that cannot be expressed via the typed API.
	 */
	sendRaw(json: string): void {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}
		this.process.stdin.write(`${json.replace(/\n+$/, "")}\n`);
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line) as unknown;
			if (!isRecord(data)) {
				return;
			}

			// Correlated response to a pending request
			if (isPendingResponseEnvelope(data) && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				pending.resolve(data);
				return;
			}

			for (const listener of this.protocolListeners) {
				listener(data as RpcProtocolMessage);
			}

			if (!isAgentEvent(data)) {
				return;
			}

			for (const listener of this.eventListeners) {
				listener(data);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const rpcProcess = this.process;

		return new Promise((resolve, reject) => {
			let settled = false;

			const cleanup = () => {
				clearTimeout(timeout);
				rpcProcess.off("exit", onExit);
				rpcProcess.off("error", onProcessError);
			};

			const finishResolve = (response: RpcResponse) => {
				if (settled) return;
				settled = true;
				this.pendingRequests.delete(id);
				cleanup();
				resolve(response);
			};

			const finishReject = (error: Error) => {
				if (settled) return;
				settled = true;
				this.pendingRequests.delete(id);
				cleanup();
				reject(error);
			};

			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				const reason = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
				finishReject(
					new Error(`Agent process exited (${reason}) before response to ${command.type}. Stderr: ${this.stderr}`),
				);
			};

			const onProcessError = (error: Error) => {
				finishReject(
					new Error(
						`Agent process errored before response to ${command.type}: ${error.message}. Stderr: ${this.stderr}`,
					),
				);
			};

			const timeout = setTimeout(() => {
				finishReject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			rpcProcess.on("exit", onExit);
			rpcProcess.on("error", onProcessError);

			this.pendingRequests.set(id, {
				resolve: finishResolve,
				reject: finishReject,
			});

			rpcProcess.stdin!.write(`${JSON.stringify(fullCommand)}\n`);
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
