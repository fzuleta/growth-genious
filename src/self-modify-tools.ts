import { execFile } from "node:child_process";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "openai/resources/responses/responses";

const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const MAX_FILE_SIZE_BYTES = 50 * 1024;
const MAX_READ_LINES = 500;
const MAX_EXEC_BUFFER = 512 * 1024;

const ALLOWED_COMMANDS = new Set([
	"npm install",
	"npm run build",
	"npx tsc --noEmit",
]);

// ── Tool schemas for OpenAI Responses API ──

function fnTool(name: string, description: string, parameters: Record<string, unknown>): Tool {
	return { type: "function", name, description, parameters, strict: false } as Tool;
}

export const PLANNING_TOOLS: Tool[] = [
	fnTool("read_file", "Read the contents of a file in the workspace. Returns the text content. Use startLine/endLine for large files.", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root (e.g. src/bot.ts)" },
			startLine: { type: "number", description: "1-based start line (optional)" },
			endLine: { type: "number", description: "1-based end line (optional)" },
		},
		required: ["path"],
	}),
	fnTool("list_dir", "List contents of a directory. Returns file and folder names (folders end with /).", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root (e.g. src/post-types)" },
		},
		required: ["path"],
	}),
	fnTool("grep_search", "Search for a text pattern in the workspace. Returns matching lines with file paths and line numbers.", {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (plain text or regex)" },
			path: { type: "string", description: "Optional subdirectory to scope the search" },
			isRegex: { type: "boolean", description: "Whether the pattern is a regex (default false)" },
		},
		required: ["pattern"],
	}),
	fnTool("submit_plan", "Submit your implementation plan for user approval. Call this when you have enough understanding of the codebase to propose a complete plan. The plan should be detailed markdown.", {
		type: "object",
		properties: {
			plan: { type: "string", description: "Detailed implementation plan in markdown format" },
		},
		required: ["plan"],
	}),
];

export const ANALYSIS_TOOLS: Tool[] = [
	fnTool("read_file", "Read the contents of a file in the workspace. Returns the text content. Use startLine/endLine for large files.", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root (e.g. src/post-types/character-with-scenery.ts)" },
			startLine: { type: "number", description: "1-based start line (optional)" },
			endLine: { type: "number", description: "1-based end line (optional)" },
		},
		required: ["path"],
	}),
	fnTool("list_dir", "List contents of a directory. Returns file and folder names (folders end with /).", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root" },
		},
		required: ["path"],
	}),
	fnTool("grep_search", "Search for a text pattern in the workspace. Returns matching lines with file paths and line numbers.", {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (plain text or regex)" },
			path: { type: "string", description: "Optional subdirectory to scope the search" },
			isRegex: { type: "boolean", description: "Whether the pattern is a regex (default false)" },
		},
		required: ["pattern"],
	}),
	fnTool("submit_analysis", "Submit the final code analysis and recommendations. Call this when you have inspected enough code and are ready to answer.", {
		type: "object",
		properties: {
			analysis: { type: "string", description: "Detailed analysis and recommendations in markdown format" },
		},
		required: ["analysis"],
	}),
];

export const EXECUTION_TOOLS: Tool[] = [
	fnTool("read_file", "Read the contents of a file in the workspace.", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root" },
			startLine: { type: "number", description: "1-based start line (optional)" },
			endLine: { type: "number", description: "1-based end line (optional)" },
		},
		required: ["path"],
	}),
	fnTool("list_dir", "List contents of a directory.", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root" },
		},
		required: ["path"],
	}),
	fnTool("grep_search", "Search for a text pattern in the workspace.", {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern" },
			path: { type: "string", description: "Optional subdirectory scope" },
			isRegex: { type: "boolean", description: "Whether the pattern is a regex" },
		},
		required: ["pattern"],
	}),
	fnTool("write_file", "Create or overwrite a file with the given content.", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root" },
			content: { type: "string", description: "Full file content to write" },
		},
		required: ["path", "content"],
	}),
	fnTool("edit_file", "Replace an exact string in a file. The oldText must appear exactly once.", {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from workspace root" },
			oldText: { type: "string", description: "Exact text to find (must match once)" },
			newText: { type: "string", description: "Replacement text" },
		},
		required: ["path", "oldText", "newText"],
	}),
	fnTool("run_command", "Run an allowlisted shell command. Only: npm install, npm run build, npx tsc --noEmit.", {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to run" },
		},
		required: ["command"],
	}),
	fnTool("done", "Signal that all code changes are complete. Call this when you have finished all file edits.", {
		type: "object",
		properties: {
			summary: { type: "string", description: "Brief summary of changes made" },
		},
		required: ["summary"],
	}),
];

// ── Tool execution ──

function resolveAndValidatePath(relativePath: string): string {
	const resolved = path.resolve(WORKSPACE_ROOT, relativePath);
	const workspaceRootPrefix = `${WORKSPACE_ROOT}${path.sep}`;
	if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(workspaceRootPrefix)) {
		throw new Error(`Path traversal blocked: ${relativePath}`);
	}
	const realSegments = resolved.split(path.sep);
	if (realSegments.includes("..")) {
		throw new Error(`Path traversal blocked: ${relativePath}`);
	}
	return resolved;
}

async function executeReadFile(args: { path: string; startLine?: number; endLine?: number }): Promise<string> {
	const filePath = resolveAndValidatePath(args.path);
	const content = await readFile(filePath, "utf-8");
	const lines = content.split("\n");

	const start = Math.max(1, args.startLine ?? 1);
	const end = Math.min(lines.length, args.endLine ?? Math.min(lines.length, start + MAX_READ_LINES - 1));

	const selectedLines = lines.slice(start - 1, end);
	const numbered = selectedLines.map((line, index) => `${start + index}: ${line}`);
	return `File: ${args.path} (lines ${start}-${end} of ${lines.length})\n${numbered.join("\n")}`;
}

async function executeListDir(args: { path: string }): Promise<string> {
	const dirPath = resolveAndValidatePath(args.path);
	const entries = await readdir(dirPath, { withFileTypes: true });
	const names = entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
	return names.join("\n");
}

async function executeGrepSearch(args: { pattern: string; path?: string; isRegex?: boolean }): Promise<string> {
	const searchDir = args.path ? resolveAndValidatePath(args.path) : WORKSPACE_ROOT;
	const grepArgs = ["-r", "-n", "--include=*.ts", "--include=*.json", "--include=*.md"];

	if (args.isRegex) {
		grepArgs.push("-E");
	} else {
		grepArgs.push("-F");
	}

	grepArgs.push(args.pattern, searchDir);

	return new Promise((resolve) => {
		execFile("grep", grepArgs, { maxBuffer: MAX_EXEC_BUFFER }, (error, stdout, stderr) => {
			if (!stdout || stdout.trim().length === 0) {
				if (error && error.code !== 1) {
					resolve(`Search failed: ${stderr.toString().trim() || error.message}`);
					return;
				}

				resolve("No matches found.");
				return;
			}

			const lines = stdout.trim().split("\n");
			const relativized = lines
				.map((line) => line.replace(`${WORKSPACE_ROOT}/`, ""))
				.slice(0, 50);
			resolve(relativized.join("\n"));
		});
	});
}

async function executeWriteFile(args: { path: string; content: string }): Promise<string> {
	const filePath = resolveAndValidatePath(args.path);

	const contentBytes = Buffer.byteLength(args.content, "utf-8");
	if (contentBytes > MAX_FILE_SIZE_BYTES) {
		throw new Error(`File content exceeds ${MAX_FILE_SIZE_BYTES} bytes limit (got ${contentBytes})`);
	}

	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	await writeFile(filePath, args.content, "utf-8");
	return `Written ${args.path} (${contentBytes} bytes)`;
}

async function executeEditFile(args: { path: string; oldText: string; newText: string }): Promise<string> {
	const filePath = resolveAndValidatePath(args.path);
	const content = await readFile(filePath, "utf-8");

	const occurrences = content.split(args.oldText).length - 1;
	if (occurrences === 0) {
		throw new Error(`oldText not found in ${args.path}`);
	}
	if (occurrences > 1) {
		throw new Error(`oldText found ${occurrences} times in ${args.path} — must be unique`);
	}

	const newContent = content.replace(args.oldText, args.newText);
	await writeFile(filePath, newContent, "utf-8");
	return `Edited ${args.path}: replaced ${args.oldText.length} chars with ${args.newText.length} chars`;
}

async function executeRunCommand(args: { command: string }): Promise<string> {
	const trimmedCommand = args.command.trim();
	if (!ALLOWED_COMMANDS.has(trimmedCommand)) {
		throw new Error(`Command not allowed: ${trimmedCommand}. Allowed: ${Array.from(ALLOWED_COMMANDS).join(", ")}`);
	}

	const [binary, ...cmdArgs] = trimmedCommand.split(" ");
	return new Promise((resolve) => {
		execFile(
			binary,
			cmdArgs,
			{ cwd: WORKSPACE_ROOT, maxBuffer: MAX_EXEC_BUFFER, timeout: 120_000 },
			(error, stdout, stderr) => {
				const output = [stdout.toString().trim(), stderr.toString().trim()].filter(Boolean).join("\n");
				if (error) {
					resolve(`Command failed (exit ${error.code ?? "unknown"}):\n${output}`);
					return;
				}
				resolve(`Command succeeded:\n${output}`);
			},
		);
	});
}

export interface ToolCallResult {
	output: string;
	isTerminal: boolean;
	terminalPayload?: string;
}

export async function executeToolCall(
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolCallResult> {
	try {
		switch (toolName) {
			case "read_file":
				return { output: await executeReadFile(args as Parameters<typeof executeReadFile>[0]), isTerminal: false };
			case "list_dir":
				return { output: await executeListDir(args as Parameters<typeof executeListDir>[0]), isTerminal: false };
			case "grep_search":
				return { output: await executeGrepSearch(args as Parameters<typeof executeGrepSearch>[0]), isTerminal: false };
			case "write_file":
				return { output: await executeWriteFile(args as Parameters<typeof executeWriteFile>[0]), isTerminal: false };
			case "edit_file":
				return { output: await executeEditFile(args as Parameters<typeof executeEditFile>[0]), isTerminal: false };
			case "run_command":
				return { output: await executeRunCommand(args as Parameters<typeof executeRunCommand>[0]), isTerminal: false };
			case "submit_plan":
				return { output: "Plan submitted.", isTerminal: true, terminalPayload: (args as { plan: string }).plan };
				case "submit_analysis":
					return { output: "Analysis submitted.", isTerminal: true, terminalPayload: (args as { analysis: string }).analysis };
			case "done":
				return { output: "Execution complete.", isTerminal: true, terminalPayload: (args as { summary: string }).summary };
			default:
				return { output: `Unknown tool: ${toolName}`, isTerminal: false };
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { output: `Error: ${message}`, isTerminal: false };
	}
}
