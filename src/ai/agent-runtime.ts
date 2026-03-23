import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { resolveAiTextTaskConfig, convertResponseInputToChatMessages } from "./text-router";
import { createOpenAIClient } from "../openai/openai";
import type { PluginContract } from "../plugin-contract";
import { ANALYSIS_TOOLS, EXECUTION_TOOLS, PLANNING_TOOLS, executeToolCall, type ToolCallResult } from "../self-modify-tools";

type AgentToolSetKind = "analysis" | "planning" | "execution";

interface AgentToolExecutionEvent {
	tool: string;
	args: Record<string, unknown>;
	result: ToolCallResult;
}

interface RunAgentLoopInput {
	task: "agent";
	plugin?: PluginContract | null;
	conversationItems: ResponseInputItem[];
	toolSet: AgentToolSetKind;
	maxIterations: number;
	onToolResult?: (event: AgentToolExecutionEvent) => Promise<void> | void;
}

export async function runAgentLoop(input: RunAgentLoopInput): Promise<{ model: string; provider: "openai" | "openrouter"; output: string }> {
	const { provider, model } = resolveAiTextTaskConfig(input.task, { plugin: input.plugin });
	if (provider === "openrouter") {
		const output = await runOpenRouterAgentLoop(input, model);
		return { provider, model, output };
	}

	const output = await runOpenAiAgentLoop(input, model);
	return { provider, model, output };
}

async function runOpenAiAgentLoop(input: RunAgentLoopInput, model: string): Promise<string> {
	const client = createOpenAIClient();
	const conversationItems = [...input.conversationItems];

	for (let i = 0; i < input.maxIterations; i++) {
		const response = await client.responses.create({
			model,
			input: conversationItems,
			tools: getOpenAiTools(input.toolSet),
		});

		const functionCalls = response.output.filter(
			(item): item is typeof item & { type: "function_call" } => item.type === "function_call",
		);

		if (functionCalls.length === 0) {
			return response.output_text.trim();
		}

		for (const call of response.output) {
			conversationItems.push(call as unknown as ResponseInputItem);
		}

		for (const call of functionCalls) {
			const args = JSON.parse(call.arguments) as Record<string, unknown>;
			const result = await executeToolCall(call.name, args);
			await input.onToolResult?.({ tool: call.name, args, result });

			conversationItems.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: result.output,
			} as unknown as ResponseInputItem);

			if (result.isTerminal && result.terminalPayload) {
				return result.terminalPayload;
			}
		}
	}

	return "Agent loop exhausted the iteration limit without producing a final result.";
}

async function runOpenRouterAgentLoop(input: RunAgentLoopInput, model: string): Promise<string> {
	const apiKey = process.env.OPENROUTER_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("Missing OPENROUTER_API_KEY. Set it in the environment when AI_PROVIDER=openrouter.");
	}

	const { OpenRouter, fromChatMessages, hasToolCall, stepCountIs, tool } = await import("@openrouter/sdk");
	let terminalPayload: string | null = null;

	const tools = buildOpenRouterTools(tool, input.toolSet, async (event) => {
		if (event.result.isTerminal && event.result.terminalPayload) {
			terminalPayload = event.result.terminalPayload;
		}
		await input.onToolResult?.(event);
	});

	const client = new OpenRouter({
		apiKey,
		httpReferer: process.env.OPENROUTER_HTTP_REFERER?.trim(),
		xTitle: process.env.OPENROUTER_X_TITLE?.trim() || "growth-genious",
	});

	const result = client.callModel({
		model,
		input: fromChatMessages(convertResponseInputToChatMessages(input.conversationItems) as Parameters<typeof fromChatMessages>[0]),
		tools,
		stopWhen: [hasToolCall(getTerminalToolName(input.toolSet)), stepCountIs(input.maxIterations)],
	});

	await result.getResponse();
	if (terminalPayload) {
		return terminalPayload;
	}

	return (await result.getText()).trim();
}

function getOpenAiTools(toolSet: AgentToolSetKind) {
	switch (toolSet) {
		case "analysis":
			return ANALYSIS_TOOLS;
		case "planning":
			return PLANNING_TOOLS;
		case "execution":
			return EXECUTION_TOOLS;
	}
}

function getTerminalToolName(toolSet: AgentToolSetKind): string {
	switch (toolSet) {
		case "analysis":
			return "submit_analysis";
		case "planning":
			return "submit_plan";
		case "execution":
			return "done";
	}
}

async function buildToolResult(
	toolName: string,
	args: Record<string, unknown>,
	onToolResult: (event: AgentToolExecutionEvent) => Promise<void> | void,
): Promise<{ output: string }> {
	const result = await executeToolCall(toolName, args);
	await onToolResult({ tool: toolName, args, result });
	return { output: result.output };
}

function buildOpenRouterTools(
	toolFactory: typeof import("@openrouter/sdk").tool,
	toolSet: AgentToolSetKind,
	onToolResult: (event: AgentToolExecutionEvent) => Promise<void> | void,
) {
	const outputSchema = z.object({ output: z.string() });
	const baseTools = [
		toolFactory({
			name: "read_file",
			description: "Read the contents of a file in the workspace. Returns the text content. Use startLine/endLine for large files.",
			inputSchema: z.object({
				path: z.string(),
				startLine: z.number().optional(),
				endLine: z.number().optional(),
			}),
			outputSchema,
			execute: async (params) => buildToolResult("read_file", params, onToolResult),
		}),
		toolFactory({
			name: "list_dir",
			description: "List contents of a directory. Returns file and folder names (folders end with /).",
			inputSchema: z.object({ path: z.string() }),
			outputSchema,
			execute: async (params) => buildToolResult("list_dir", params, onToolResult),
		}),
		toolFactory({
			name: "grep_search",
			description: "Search for a text pattern in the workspace. Returns matching lines with file paths and line numbers.",
			inputSchema: z.object({
				pattern: z.string(),
				path: z.string().optional(),
				isRegex: z.boolean().optional(),
			}),
			outputSchema,
			execute: async (params) => buildToolResult("grep_search", params, onToolResult),
		}),
	];

	if (toolSet === "analysis") {
		return [
			...baseTools,
			toolFactory({
				name: "submit_analysis",
				description: "Submit the final code analysis and recommendations.",
				inputSchema: z.object({ analysis: z.string() }),
				outputSchema,
				execute: async (params) => buildToolResult("submit_analysis", params, onToolResult),
			}),
		] as const;
	}

	if (toolSet === "planning") {
		return [
			...baseTools,
			toolFactory({
				name: "submit_plan",
				description: "Submit your implementation plan for user approval.",
				inputSchema: z.object({ plan: z.string() }),
				outputSchema,
				execute: async (params) => buildToolResult("submit_plan", params, onToolResult),
			}),
		] as const;
	}

	return [
		...baseTools,
		toolFactory({
			name: "write_file",
			description: "Create or overwrite a file with the given content.",
			inputSchema: z.object({ path: z.string(), content: z.string() }),
			outputSchema,
			execute: async (params) => buildToolResult("write_file", params, onToolResult),
		}),
		toolFactory({
			name: "edit_file",
			description: "Replace an exact string in a file. The oldText must appear exactly once.",
			inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
			outputSchema,
			execute: async (params) => buildToolResult("edit_file", params, onToolResult),
		}),
		toolFactory({
			name: "run_command",
			description: "Run an allowlisted shell command. Only: npm install, npm run build, npx tsc --noEmit.",
			inputSchema: z.object({ command: z.string() }),
			outputSchema,
			execute: async (params) => buildToolResult("run_command", params, onToolResult),
		}),
		toolFactory({
			name: "done",
			description: "Signal that all code changes are complete.",
			inputSchema: z.object({ summary: z.string() }),
			outputSchema,
			execute: async (params) => buildToolResult("done", params, onToolResult),
		}),
	] as const;
}