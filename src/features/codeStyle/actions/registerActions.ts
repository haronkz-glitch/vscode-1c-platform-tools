import type { ActionRegistry } from './registry';
/** Task 1 intentionally has no application actions; future actions are registered here only. */
export function registerActions(_registry: ActionRegistry): void {
	// No listRules/check/getIssues/fix actions until the transport stage.
}
