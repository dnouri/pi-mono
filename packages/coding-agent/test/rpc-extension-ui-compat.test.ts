import { describe, expect, test } from "vitest";
import { createSetEditorTextRequests } from "../src/modes/rpc/rpc-mode.js";

describe("RPC extension UI setEditorText compatibility", () => {
	test("creates camelCase and legacy request variants", () => {
		const requests = createSetEditorTextRequests("prefilled text");

		expect(requests).toHaveLength(2);
		expect(requests[0]?.method).toBe("setEditorText");
		expect(requests[1]?.method).toBe("set_editor_text");
		expect(requests[0]?.text).toBe("prefilled text");
		expect(requests[1]?.text).toBe("prefilled text");
		expect(requests[0]?.id).not.toBe(requests[1]?.id);
	});
});
