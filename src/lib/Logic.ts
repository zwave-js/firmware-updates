import jsonLogic, { type RulesLogic } from "json-logic-js";
import * as semver from "semver";
import { parse } from "./LogicParser.js";
import { DeviceID, padVersion } from "./shared.js";

const { add_operation, apply } = jsonLogic;

function tryOr<T extends (...args: any[]) => any>(
	operation: T,
	onError: ReturnType<T>
): T {
	return ((...args: any[]) => {
		try {
			return operation(...args);
		} catch {
			return onError;
		}
	}) as any as T;
}

add_operation(
	"ver >=",
	tryOr((a, b) => semver.gte(padVersion(a), padVersion(b)), false)
);
add_operation(
	"ver >",
	tryOr((a, b) => semver.gt(padVersion(a), padVersion(b)), false)
);
add_operation(
	"ver <=",
	tryOr((a, b) => semver.lte(padVersion(a), padVersion(b)), false)
);
add_operation(
	"ver <",
	tryOr((a, b) => semver.lt(padVersion(a), padVersion(b)), false)
);
add_operation(
	"ver ===",
	tryOr((a, b) => semver.eq(padVersion(a), padVersion(b)), false)
);

export function parseLogic(logic: string): RulesLogic {
	return parse(logic);
}

export function evaluate(
	logic: string,
	context: unknown
): string | number | boolean {
	const rules = parseLogic(logic);
	return apply(rules, context);
}

export interface ConditionalItem {
	readonly $if?: string;
}

/** Checks if a given condition applies for the given device ID */
export function conditionApplies(
	self: ConditionalItem,
	deviceId: DeviceID | undefined
): boolean {
	// No condition? Always applies
	if (!self.$if) return true;
	// No device ID? Always applies
	if (!deviceId) return true;

	try {
		return !!evaluate(self.$if, deviceId);
	} catch (e) {
		throw new Error(`Invalid condition "${self.$if}"!`);
	}
}
