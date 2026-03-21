const LOG_JSON_INDENT = "  ";
const INLINE_OBJECT_MAX_DEPTH = 1;

export function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();

	try {
		return stringifyForLog(value, 0, seen);
	} catch {
		return JSON.stringify({ contextSerializationError: true });
	}
}

function stringifyForLog(value: unknown, depth: number, seen: WeakSet<object>): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (seen.has(value)) {
		return JSON.stringify("[Circular]");
	}

	seen.add(value);

	if (Array.isArray(value)) {
		const formattedItems = value.map((item) => stringifyForLog(item, depth + 1, seen));
		seen.delete(value);
		return `[${formattedItems.join(", ")}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) {
		seen.delete(value);
		return "{}";
	}

	if (depth <= INLINE_OBJECT_MAX_DEPTH) {
		const inlineEntries = entries
			.map(([key, item]) => `${JSON.stringify(key)}: ${stringifyForLog(item, depth + 1, seen)}`)
			.join(", ");
		seen.delete(value);
		return `{ ${inlineEntries} }`;
	}

	const currentIndent = LOG_JSON_INDENT.repeat(depth);
	const nestedIndent = LOG_JSON_INDENT.repeat(depth + 1);
	const multilineEntries = entries.map(
		([key, item]) =>
			`${nestedIndent}${JSON.stringify(key)}: ${stringifyForLog(item, depth + 1, seen)}`,
	);

	seen.delete(value);
	return `{\n${multilineEntries.join(",\n")}\n${currentIndent}}`;
}
