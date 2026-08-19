import jsonLogic, { type RulesLogic } from "json-logic-js";
import * as semver from "semver";
import { parse, toRulesLogic } from "./LogicParser.js";
import { DeviceID, padVersion } from "./shared.js";

const { add_operation, apply } = jsonLogic;

function tryOr<T extends (...args: any[]) => any>(
	operation: T,
	onError: ReturnType<T>,
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
	tryOr((a, b) => semver.gte(padVersion(a), padVersion(b)), false),
);
add_operation(
	"ver >",
	tryOr((a, b) => semver.gt(padVersion(a), padVersion(b)), false),
);
add_operation(
	"ver <=",
	tryOr((a, b) => semver.lte(padVersion(a), padVersion(b)), false),
);
add_operation(
	"ver <",
	tryOr((a, b) => semver.lt(padVersion(a), padVersion(b)), false),
);
add_operation(
	"ver ===",
	tryOr((a, b) => semver.eq(padVersion(a), padVersion(b)), false),
);
add_operation(
	"ver !==",
	tryOr((a, b) => !semver.eq(padVersion(a), padVersion(b)), false),
);

export function parseLogic(logic: string): RulesLogic {
	const expr = parse(logic);
	if (!expr) {
		throw new Error(`Failed to parse expression: ${logic}`);
	}
	return toRulesLogic(expr);
}

export function evaluate(
	logic: string,
	context: unknown,
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
	context: DeviceID | undefined,
): boolean {
	// No condition? Always applies
	if (!self.$if) return true;
	// No device ID? Always applies
	if (!context) return true;

	try {
		return !!evaluate(self.$if, context);
	} catch {
		throw new Error(`Invalid condition "${self.$if}"!`);
	}
}
