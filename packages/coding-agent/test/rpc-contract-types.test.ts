import { describe, expect, expectTypeOf, test } from "vitest";
import type {
	RpcClient,
	RpcCommand,
	RpcCommandByType,
	RpcCommandType,
	RpcGetTreeResult,
	RpcListSessionsResult,
	RpcNavigateTreeResult,
	RpcResponse,
	RpcResponseFor,
	RpcSlashCommand,
} from "../src/modes/index.js";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.js";

describe("RPC protocol type contracts", () => {
	test("every command has a matching success response variant", () => {
		type SuccessCommand = Extract<RpcResponse, { success: true }>["command"];
		type MissingSuccess = Exclude<RpcCommandType, SuccessCommand>;
		expectTypeOf({} as { missing: MissingSuccess }).toEqualTypeOf<{ missing: never }>();
	});

	test("list_sessions and get_commands responses keep exported item contracts", () => {
		type ListSessionsSuccess = Extract<RpcResponseFor<"list_sessions">, { success: true }>;
		type GetCommandsSuccess = Extract<RpcResponseFor<"get_commands">, { success: true }>;

		expectTypeOf<ListSessionsSuccess["data"]>().toEqualTypeOf<RpcListSessionsResult>();
		expectTypeOf<GetCommandsSuccess["data"]>().toEqualTypeOf<{ commands: RpcSlashCommand[] }>();
	});

	test("get_last_assistant_text data shape matches runtime omission behavior", () => {
		type LastAssistantTextSuccess = Extract<RpcResponseFor<"get_last_assistant_text">, { success: true }>;

		expectTypeOf<LastAssistantTextSuccess["data"]["text"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<RpcClient["getLastAssistantText"]>().returns.toEqualTypeOf<Promise<string | undefined>>();
	});

	test("tree command/response contracts stay aligned", () => {
		type GetTreeSuccess = Extract<RpcResponseFor<"get_tree">, { success: true }>;
		type NavigateCommand = RpcCommandByType<"navigate_tree">;
		type NavigateSuccess = Extract<RpcResponseFor<"navigate_tree">, { success: true }>;

		expectTypeOf<GetTreeSuccess["data"]>().toEqualTypeOf<RpcGetTreeResult>();
		expectTypeOf<NavigateCommand["targetId"]>().toEqualTypeOf<string>();
		expectTypeOf<NavigateCommand["summarize"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<NavigateCommand["customInstructions"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<NavigateCommand["replaceInstructions"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<NavigateCommand["label"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<NavigateSuccess["data"]>().toEqualTypeOf<RpcNavigateTreeResult>();
	});

	test("command extraction helper preserves discriminated command shape", () => {
		type RenameCommand = RpcCommandByType<"rename_session">;
		type DeleteCommand = RpcCommandByType<"delete_session">;
		type MutationCommands = Extract<RpcCommand, { type: "rename_session" | "delete_session" }>;

		expectTypeOf<RenameCommand>().toMatchTypeOf<{ type: "rename_session"; sessionPath: string; name: string }>();
		expectTypeOf<DeleteCommand>().toMatchTypeOf<{ type: "delete_session"; sessionPath: string }>();
		expectTypeOf<MutationCommands>().toMatchTypeOf<RenameCommand | DeleteCommand>();
	});

	test("extension UI setEditorText request keeps camelCase alias and legacy snake_case method", () => {
		const camelCaseRequest: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "req-camel",
			method: "setEditorText",
			text: "hello",
		};
		const legacyRequest: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "req-legacy",
			method: "set_editor_text",
			text: "hello",
		};

		expect(camelCaseRequest.method).toBe("setEditorText");
		expect(legacyRequest.method).toBe("set_editor_text");
	});
});
