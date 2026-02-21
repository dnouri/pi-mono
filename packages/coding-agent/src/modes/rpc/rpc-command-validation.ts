import { isAbsolute } from "node:path";
import type { RpcCommand, RpcExtensionUIResponse } from "./rpc-types.js";

export interface RpcInputError {
	id: string | undefined;
	command: string;
	message: string;
}

export type RpcParsedInput =
	| { kind: "command"; command: RpcCommand }
	| { kind: "extension_ui_response"; response: RpcExtensionUIResponse }
	| { kind: "error"; error: RpcInputError };

export function parseRpcInputLine(line: string): RpcParsedInput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		return {
			kind: "error",
			error: {
				id: undefined,
				command: "parse",
				message: `Failed to parse command: ${toErrorMessage(error)}`,
			},
		};
	}

	if (!isRecord(parsed)) {
		return {
			kind: "error",
			error: {
				id: undefined,
				command: "parse",
				message: "Invalid command payload: expected a JSON object",
			},
		};
	}

	const type = parsed.type;
	if (typeof type !== "string") {
		return {
			kind: "error",
			error: {
				id: extractId(parsed),
				command: "parse",
				message: 'Invalid command payload: "type" must be a string',
			},
		};
	}

	if (type === "extension_ui_response") {
		const extensionError = validateExtensionUiResponse(parsed);
		if (extensionError) {
			return {
				kind: "error",
				error: {
					id: extractId(parsed),
					command: "extension_ui_response",
					message: extensionError,
				},
			};
		}
		return { kind: "extension_ui_response", response: parsed as RpcExtensionUIResponse };
	}

	if ("id" in parsed && parsed.id !== undefined && typeof parsed.id !== "string") {
		return {
			kind: "error",
			error: {
				id: undefined,
				command: type,
				message: `Invalid command payload for "${type}": "id" must be a string`,
			},
		};
	}

	const payloadError = validateCommandPayload(type, parsed);
	if (payloadError) {
		return {
			kind: "error",
			error: {
				id: extractId(parsed),
				command: type,
				message: payloadError,
			},
		};
	}

	return { kind: "command", command: parsed as RpcCommand };
}

function validateExtensionUiResponse(payload: Record<string, unknown>): string | undefined {
	if (typeof payload.id !== "string") {
		return 'Invalid extension UI response: "id" must be a string';
	}

	if ("cancelled" in payload) {
		if (payload.cancelled !== true) {
			return 'Invalid extension UI response: "cancelled" must be true when provided';
		}
		return undefined;
	}

	if ("value" in payload) {
		if (typeof payload.value !== "string") {
			return 'Invalid extension UI response: "value" must be a string';
		}
		return undefined;
	}

	if ("confirmed" in payload) {
		if (typeof payload.confirmed !== "boolean") {
			return 'Invalid extension UI response: "confirmed" must be a boolean';
		}
		return undefined;
	}

	return "Invalid extension UI response: expected one of value, confirmed, or cancelled";
}

function validateCommandPayload(type: string, payload: Record<string, unknown>): string | undefined {
	switch (type) {
		case "prompt": {
			return (
				requireStringField(type, payload, "message") ??
				requireOptionalUnionField(type, payload, "streamingBehavior", ["steer", "followUp"]) ??
				requireOptionalImageContentArrayField(type, payload, "images")
			);
		}
		case "steer":
		case "follow_up":
			return (
				requireStringField(type, payload, "message") ??
				requireOptionalImageContentArrayField(type, payload, "images")
			);
		case "bash":
			return requireStringField(type, payload, "command");
		case "set_model": {
			return requireStringField(type, payload, "provider") ?? requireStringField(type, payload, "modelId");
		}
		case "set_thinking_level":
			return requireUnionField(type, payload, "level", ["off", "minimal", "low", "medium", "high", "xhigh"]);
		case "set_steering_mode":
		case "set_follow_up_mode":
			return requireUnionField(type, payload, "mode", ["all", "one-at-a-time"]);
		case "compact":
			return requireOptionalStringField(type, payload, "customInstructions");
		case "set_auto_compaction":
		case "set_auto_retry":
			return requireBooleanField(type, payload, "enabled");
		case "export_html":
			return requireOptionalStringField(type, payload, "outputPath");
		case "switch_session":
			return requireStringField(type, payload, "sessionPath");
		case "delete_session":
			return requireAbsolutePathField(type, payload, "sessionPath");
		case "fork":
			return requireStringField(type, payload, "entryId");
		case "set_label":
			return requireStringField(type, payload, "entryId") ?? requireOptionalStringField(type, payload, "label");
		case "set_session_name":
			return requireStringField(type, payload, "name");
		case "new_session":
			return requireOptionalStringField(type, payload, "parentSession");
		case "list_sessions": {
			return (
				requireOptionalUnionField(type, payload, "scope", ["current", "all"]) ??
				requireOptionalBooleanField(type, payload, "includeSearchText")
			);
		}
		case "rename_session": {
			return requireAbsolutePathField(type, payload, "sessionPath") ?? requireStringField(type, payload, "name");
		}
		case "get_tree":
			return requireOptionalBooleanField(type, payload, "includeContent");
		case "navigate_tree": {
			return (
				requireStringField(type, payload, "targetId") ??
				requireOptionalBooleanField(type, payload, "summarize") ??
				requireOptionalStringField(type, payload, "customInstructions") ??
				requireOptionalBooleanField(type, payload, "replaceInstructions") ??
				requireOptionalStringField(type, payload, "label")
			);
		}
		default:
			return undefined;
	}
}

function requireStringField(commandType: string, payload: Record<string, unknown>, field: string): string | undefined {
	if (typeof payload[field] !== "string") {
		return `Invalid command payload for "${commandType}": "${field}" must be a string`;
	}
	return undefined;
}

function requireAbsolutePathField(
	commandType: string,
	payload: Record<string, unknown>,
	field: string,
): string | undefined {
	const typeError = requireStringField(commandType, payload, field);
	if (typeError) {
		return typeError;
	}
	const path = payload[field] as string;
	if (!isAbsolute(path)) {
		return `Invalid command payload for "${commandType}": "${field}" must be an absolute path`;
	}
	return undefined;
}

function requireOptionalStringField(
	commandType: string,
	payload: Record<string, unknown>,
	field: string,
): string | undefined {
	if (payload[field] === undefined) {
		return undefined;
	}
	if (typeof payload[field] !== "string") {
		return `Invalid command payload for "${commandType}": "${field}" must be a string`;
	}
	return undefined;
}

function requireBooleanField(commandType: string, payload: Record<string, unknown>, field: string): string | undefined {
	if (typeof payload[field] !== "boolean") {
		return `Invalid command payload for "${commandType}": "${field}" must be a boolean`;
	}
	return undefined;
}

function requireOptionalBooleanField(
	commandType: string,
	payload: Record<string, unknown>,
	field: string,
): string | undefined {
	if (payload[field] === undefined) {
		return undefined;
	}
	if (typeof payload[field] !== "boolean") {
		return `Invalid command payload for "${commandType}": "${field}" must be a boolean`;
	}
	return undefined;
}

function requireUnionField(
	commandType: string,
	payload: Record<string, unknown>,
	field: string,
	allowed: string[],
): string | undefined {
	if (typeof payload[field] !== "string" || !allowed.includes(payload[field] as string)) {
		return `Invalid command payload for "${commandType}": "${field}" must be ${joinAllowedValues(allowed)}`;
	}
	return undefined;
}

function requireOptionalUnionField(
	commandType: string,
	payload: Record<string, unknown>,
	field: string,
	allowed: string[],
): string | undefined {
	if (payload[field] === undefined) {
		return undefined;
	}
	if (typeof payload[field] !== "string" || !allowed.includes(payload[field] as string)) {
		return `Invalid command payload for "${commandType}": "${field}" must be ${joinAllowedValues(allowed)}`;
	}
	return undefined;
}

function requireOptionalImageContentArrayField(
	commandType: string,
	payload: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = payload[field];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return `Invalid command payload for "${commandType}": "${field}" must be an array of ImageContent objects`;
	}

	for (let i = 0; i < value.length; i++) {
		const image = value[i];
		if (
			!isRecord(image) ||
			image.type !== "image" ||
			typeof image.data !== "string" ||
			typeof image.mimeType !== "string"
		) {
			return `Invalid command payload for "${commandType}": "${field}[${i}]" must be an object with type "image", string "data", and string "mimeType"`;
		}
	}

	return undefined;
}

function joinAllowedValues(values: string[]): string {
	if (values.length === 1) {
		return `"${values[0]}"`;
	}
	if (values.length === 2) {
		return `"${values[0]}" or "${values[1]}"`;
	}
	const head = values
		.slice(0, -1)
		.map((value) => `"${value}"`)
		.join(", ");
	const tail = values[values.length - 1];
	return `${head}, or "${tail}"`;
}

function extractId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.id === "string" ? payload.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
