import test from "ava";
import {
	type Expression,
	Operator,
	SyntaxKind,
	type Token,
	TokenKind,
	parse,
	tokenize,
	toRulesLogic,
} from "./LogicParser.js";

test("tokenize, happy path 1", (t) => {
	const input = "a && b || ((c == d === e != f)) !== g < h <= i > j >= k";
	const actual: Omit<Token, "start">[] = Array.from(tokenize(input)).map(
		(token) => {
			const { start, ...rest } = token;
			return rest;
		},
	);
	const expected: Omit<Token, "start">[] = [
		{ kind: TokenKind.Identifier, value: "a" },
		{ kind: TokenKind.AmpAmp },
		{ kind: TokenKind.Identifier, value: "b" },
		{ kind: TokenKind.BarBar },
		{ kind: TokenKind.LeftParen },
		{ kind: TokenKind.LeftParen },
		{ kind: TokenKind.Identifier, value: "c" },
		{ kind: TokenKind.EqualsEquals },
		{ kind: TokenKind.Identifier, value: "d" },
		{ kind: TokenKind.EqualsEqualsEquals },
		{ kind: TokenKind.Identifier, value: "e" },
		{ kind: TokenKind.ExclamationEquals },
		{ kind: TokenKind.Identifier, value: "f" },
		{ kind: TokenKind.RightParen },
		{ kind: TokenKind.RightParen },
		{ kind: TokenKind.ExclamationEqualsEquals },
		{ kind: TokenKind.Identifier, value: "g" },
		{ kind: TokenKind.LessThan },
		{ kind: TokenKind.Identifier, value: "h" },
		{ kind: TokenKind.LessThanEquals },
		{ kind: TokenKind.Identifier, value: "i" },
		{ kind: TokenKind.GreaterThan },
		{ kind: TokenKind.Identifier, value: "j" },
		{ kind: TokenKind.GreaterThanEquals },
		{ kind: TokenKind.Identifier, value: "k" },
	];
	t.deepEqual(actual, expected);
});

test("tokenize, happy path 2", (t) => {
	const input =
		"firmwareVersion>= 1.2.3 && (productType == 0x1234 || productId !== 5)";
	const actual: Omit<Token, "start">[] = Array.from(tokenize(input)).map(
		(token) => {
			const { start, ...rest } = token;
			return rest;
		},
	);
	const expected: Omit<Token, "start">[] = [
		{ kind: TokenKind.Identifier, value: "firmwareVersion" },
		{ kind: TokenKind.GreaterThanEquals },
		{ kind: TokenKind.NumberLiteral, value: "1" },
		{ kind: TokenKind.Dot },
		{ kind: TokenKind.NumberLiteral, value: "2" },
		{ kind: TokenKind.Dot },
		{ kind: TokenKind.NumberLiteral, value: "3" },
		{ kind: TokenKind.AmpAmp },
		{ kind: TokenKind.LeftParen },
		{ kind: TokenKind.Identifier, value: "productType" },
		{ kind: TokenKind.EqualsEquals },
		{ kind: TokenKind.NumberLiteral, value: "0x1234" },
		{ kind: TokenKind.BarBar },
		{ kind: TokenKind.Identifier, value: "productId" },
		{ kind: TokenKind.ExclamationEqualsEquals },
		{ kind: TokenKind.NumberLiteral, value: "5" },
		{ kind: TokenKind.RightParen },
	];
	t.deepEqual(actual, expected);
});

test("tokenize, with illegal characters", (t) => {
	const input = "a + b - c * d / e % f";
	t.throws(() => Array.from(tokenize(input)), {
		message: /Unexpected character '\+' at index 2/,
	});
});

test("parse, simple comparison", (t) => {
	const input = "abc == 5";
	const actual = parse(input);
	const expected: Expression = {
		kind: SyntaxKind.Comparison,
		operator: Operator.Equal,
		left: {
			kind: SyntaxKind.Identifier,
			name: "abc",
		},
		right: {
			kind: SyntaxKind.NumberLiteral,
			value: 5,
		},
	};
	t.deepEqual(actual, expected);
});

test("parse, illegal comparison", (t) => {
	const input = "a == b";
	t.throws(() => parse(input), {
		message: /Right-hand side of comparisons must be a version or number literal/,
	});
});

test("parse, version comparison", (t) => {
	const input = "firmwareVersion >= 1.2.3";
	const actual = parse(input);
	const expected: Expression = {
		kind: SyntaxKind.Comparison,
		operator: Operator.GreaterThanOrEqual,
		left: {
			kind: SyntaxKind.Identifier,
			name: "firmwareVersion",
		},
		right: {
			kind: SyntaxKind.Version,
			value: "1.2.3",
		},
	};
	t.deepEqual(actual, expected);
});

test("parse, OR chain", (t) => {
	const input = "a > 2 || b < 0x1234 || c === 1.0";
	const actual = parse(input);
	const expected: Expression = {
		kind: SyntaxKind.Or,
		operands: [
			{
				kind: SyntaxKind.Comparison,
				operator: Operator.GreaterThan,
				left: {
					kind: SyntaxKind.Identifier,
					name: "a",
				},
				right: {
					kind: SyntaxKind.NumberLiteral,
					value: 2,
				},
			},
			{
				kind: SyntaxKind.Comparison,
				operator: Operator.LessThan,
				left: {
					kind: SyntaxKind.Identifier,
					name: "b",
				},
				right: {
					kind: SyntaxKind.NumberLiteral,
					value: 0x1234,
				},
			},
			{
				kind: SyntaxKind.Comparison,
				operator: Operator.Equal,
				left: {
					kind: SyntaxKind.Identifier,
					name: "c",
				},
				right: {
					kind: SyntaxKind.Version,
					value: "1.0",
				},
			},
		],
	};
	t.deepEqual(actual, expected);
});

test("parse, grouped AND/OR with operator precendence", (t) => {
	const input = "(a <= 5 || b >= 10) && c != 0x1A2B || d === 3.4.5";
	const actual = parse(input);
	const expected: Expression = {
		kind: SyntaxKind.Or,
		operands: [
			{
				kind: SyntaxKind.And,
				operands: [
					{
						kind: SyntaxKind.Or,
						operands: [
							{
								kind: SyntaxKind.Comparison,
								operator: Operator.LessThanOrEqual,
								left: {
									kind: SyntaxKind.Identifier,
									name: "a",
								},
								right: {
									kind: SyntaxKind.NumberLiteral,
									value: 5,
								},
							},
							{
								kind: SyntaxKind.Comparison,
								operator: Operator.GreaterThanOrEqual,
								left: {
									kind: SyntaxKind.Identifier,
									name: "b",
								},
								right: {
									kind: SyntaxKind.NumberLiteral,
									value: 10,
								},
							},
						],
					},
					{
						kind: SyntaxKind.Comparison,
						operator: Operator.NotEqual,
						left: {
							kind: SyntaxKind.Identifier,
							name: "c",
						},
						right: {
							kind: SyntaxKind.NumberLiteral,
							value: 0x1a2b,
						},
					},
				],
			},
			{
				kind: SyntaxKind.Comparison,
				operator: Operator.Equal,
				left: {
					kind: SyntaxKind.Identifier,
					name: "d",
				},
				right: {
					kind: SyntaxKind.Version,
					value: "3.4.5",
				},
			},
		],
	};
	t.deepEqual(actual, expected);
});

test("parse, weird, but valid expression", (t) => {
	const input = "((((a > 1)) || b <= 2))";
	const actual = parse(input);
	const expected: Expression = {
		kind: SyntaxKind.Or,
		operands: [
			{
				kind: SyntaxKind.Comparison,
				operator: Operator.GreaterThan,
				left: {
					kind: SyntaxKind.Identifier,
					name: "a",
				},
				right: {
					kind: SyntaxKind.NumberLiteral,
					value: 1,
				},
			},
			{
				kind: SyntaxKind.Comparison,
				operator: Operator.LessThanOrEqual,
				left: {
					kind: SyntaxKind.Identifier,
					name: "b",
				},
				right: {
					kind: SyntaxKind.NumberLiteral,
					value: 2,
				},
			},
		],
	};
	t.deepEqual(actual, expected);
});

test("tokenize, empty input", (t) => {
	t.deepEqual(Array.from(tokenize("")), []);
});

test("tokenize, whitespace only", (t) => {
	t.deepEqual(Array.from(tokenize("   \t\n  ")), []);
});

test("parse, empty input returns undefined", (t) => {
	t.is(parse(""), undefined);
});

test("parse, whitespace-only returns undefined", (t) => {
	t.is(parse("   "), undefined);
});

test("parse, version comparison with 2 segments", (t) => {
	const actual = parse("firmwareVersion >= 1.2");
	const expected: Expression = {
		kind: SyntaxKind.Comparison,
		operator: Operator.GreaterThanOrEqual,
		left: {
			kind: SyntaxKind.Identifier,
			name: "firmwareVersion",
		},
		right: {
			kind: SyntaxKind.Version,
			value: "1.2",
		},
	};
	t.deepEqual(actual, expected);
});

test("parse, hex number comparison", (t) => {
	const actual = parse("productId === 0xcafe");
	const expected: Expression = {
		kind: SyntaxKind.Comparison,
		operator: Operator.Equal,
		left: {
			kind: SyntaxKind.Identifier,
			name: "productId",
		},
		right: {
			kind: SyntaxKind.NumberLiteral,
			value: 0xcafe,
		},
	};
	t.deepEqual(actual, expected);
});

test("parse, all comparison operators", (t) => {
	for (const [op, expected] of [
		["<", Operator.LessThan],
		["<=", Operator.LessThanOrEqual],
		[">", Operator.GreaterThan],
		[">=", Operator.GreaterThanOrEqual],
		["==", Operator.Equal],
		["===", Operator.Equal],
		["!=", Operator.NotEqual],
		["!==", Operator.NotEqual],
	] as const) {
		const result = parse(`x ${op} 1`);
		t.is(result?.kind, SyntaxKind.Comparison);
		t.is((result as any).operator, expected, `operator ${op}`);
	}
});

test("parse, AND chain", (t) => {
	const actual = parse("a > 1 && b < 2 && c === 3");
	t.is(actual?.kind, SyntaxKind.And);
	t.is((actual as any).operands.length, 3);
});

test("parse, AND has higher precedence than OR", (t) => {
	const actual = parse("a > 1 || b < 2 && c === 3");
	t.is(actual?.kind, SyntaxKind.Or);
	const or = actual as any;
	t.is(or.operands.length, 2);
	t.is(or.operands[0].kind, SyntaxKind.Comparison);
	t.is(or.operands[1].kind, SyntaxKind.And);
	t.is(or.operands[1].operands.length, 2);
});

test("toRulesLogic, numeric comparison", (t) => {
	const expr = parse("productId === 0xcafe")!;
	t.deepEqual(toRulesLogic(expr), {
		"===": [{ var: "productId" }, 0xcafe],
	});
});

test("toRulesLogic, version comparison", (t) => {
	const expr = parse("firmwareVersion >= 1.2.3")!;
	t.deepEqual(toRulesLogic(expr), {
		"ver >=": [{ var: "firmwareVersion" }, "1.2.3"],
	});
});

test("toRulesLogic, version less-than", (t) => {
	const expr = parse("firmwareVersion < 1.0")!;
	t.deepEqual(toRulesLogic(expr), {
		"ver <": [{ var: "firmwareVersion" }, "1.0"],
	});
});

test("toRulesLogic, AND", (t) => {
	const expr = parse("firmwareVersion >= 1.1 && firmwareVersion < 1.7")!;
	t.deepEqual(toRulesLogic(expr), {
		and: [
			{ "ver >=": [{ var: "firmwareVersion" }, "1.1"] },
			{ "ver <": [{ var: "firmwareVersion" }, "1.7"] },
		],
	});
});

test("toRulesLogic, OR", (t) => {
	const expr = parse("productId === 1 || productId === 2")!;
	t.deepEqual(toRulesLogic(expr), {
		or: [
			{ "===": [{ var: "productId" }, 1] },
			{ "===": [{ var: "productId" }, 2] },
		],
	});
});

test("toRulesLogic, compound AND with hex", (t) => {
	const expr = parse(
		"firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",
	)!;
	t.deepEqual(toRulesLogic(expr), {
		and: [
			{ "ver >=": [{ var: "firmwareVersion" }, "1.1"] },
			{ "ver <": [{ var: "firmwareVersion" }, "1.7"] },
			{ "===": [{ var: "productId" }, 0xcafe] },
		],
	});
});

test("toRulesLogic, all numeric operators", (t) => {
	for (const [op, key] of [
		["<", "<"],
		["<=", "<="],
		[">", ">"],
		[">=", ">="],
		["===", "==="],
		["!==", "!=="],
	] as const) {
		const expr = parse(`x ${op} 42`)!;
		const result = toRulesLogic(expr);
		t.truthy((result as any)[key], `key ${key} for operator ${op}`);
	}
});

test("toRulesLogic, all version operators", (t) => {
	for (const [op, key] of [
		["<", "ver <"],
		["<=", "ver <="],
		[">", "ver >"],
		[">=", "ver >="],
		["===", "ver ==="],
		["!==", "ver !=="],
	] as const) {
		const expr = parse(`x ${op} 1.0`)!;
		const result = toRulesLogic(expr);
		t.truthy((result as any)[key], `key ${key} for operator ${op}`);
	}
});

test("toRulesLogic, grouped expression", (t) => {
	const expr = parse("(a > 1 || b < 2) && c === 3")!;
	t.deepEqual(toRulesLogic(expr), {
		and: [
			{
				or: [
					{ ">": [{ var: "a" }, 1] },
					{ "<": [{ var: "b" }, 2] },
				],
			},
			{ "===": [{ var: "c" }, 3] },
		],
	});
});
