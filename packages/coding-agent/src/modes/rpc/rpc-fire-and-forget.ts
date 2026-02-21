export type FireAndForgetStartResult =
	| { status: "pending" }
	| { status: "resolved" }
	| { status: "rejected"; error: string };

/**
 * Determine whether a fire-and-forget operation settles immediately or remains in-flight.
 *
 * - `rejected`: operation failed before acceptance and should be returned as command error.
 * - `resolved`: operation finished immediately (e.g. no-op / local extension command).
 * - `pending`: operation was accepted and is still running asynchronously.
 */
export async function settleFireAndForgetStart(
	operation: Promise<unknown>,
	toErrorMessage: (cause: unknown) => string,
): Promise<FireAndForgetStartResult> {
	return await Promise.race([
		operation.then(
			() => ({ status: "resolved" as const }),
			(cause: unknown) => ({ status: "rejected" as const, error: toErrorMessage(cause) }),
		),
		new Promise<{ status: "pending" }>((resolve) => {
			setImmediate(() => resolve({ status: "pending" }));
		}),
	]);
}
