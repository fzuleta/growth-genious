import type { ResponseInputItem } from "openai/resources/responses/responses";
import { readOptionalContextMarkdown } from "./context-service";
import { logInfo } from "./helpers/log";
import { createOpenAIClient } from "./openai/openai";
import { ANALYSIS_TOOLS, executeToolCall } from "./self-modify-tools";

const MAX_ANALYSIS_ITERATIONS = 20;

function getAnalysisModel(): string {
	return process.env.OPENAI_AGENT_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4o";
}

export async function runCodeAnalysis(input: {
	request: string;
	username: string;
	channelId: string;
}): Promise<string> {
	const model = getAnalysisModel();
	const contextMarkdown = await readOptionalContextMarkdown();
	const conversationItems: ResponseInputItem[] = buildAnalysisPrompt(input, contextMarkdown);
	const client = createOpenAIClient();
	let analysis: string | null = null;

	for (let i = 0; i < MAX_ANALYSIS_ITERATIONS; i++) {
		logInfo("Code-analysis iteration", {
			iteration: i + 1,
			model,
			channelId: input.channelId,
			username: input.username,
		});

		const response = await client.responses.create({
			model,
			input: conversationItems,
			tools: ANALYSIS_TOOLS,
		});

		const functionCalls = response.output.filter(
			(item): item is typeof item & { type: "function_call" } => item.type === "function_call",
		);

		if (functionCalls.length === 0) {
			analysis = response.output_text.trim();
			break;
		}

		for (const call of response.output) {
			conversationItems.push(call as unknown as ResponseInputItem);
		}

		for (const call of functionCalls) {
			const args = JSON.parse(call.arguments) as Record<string, unknown>;
			const result = await executeToolCall(call.name, args);
			conversationItems.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: result.output,
			} as unknown as ResponseInputItem);

			if (result.isTerminal && result.terminalPayload) {
				analysis = result.terminalPayload;
				break;
			}
		}

		if (analysis) {
			break;
		}
	}

	return analysis ?? "I inspected the code but could not produce a grounded analysis within the iteration limit.";
}

function buildAnalysisPrompt(
	input: {
		request: string;
		username: string;
		channelId: string;
	},
	contextMarkdown: string | null,
): ResponseInputItem[] {
	const items: ResponseInputItem[] = [
		{
			role: "system",
			content: [
				{
					type: "input_text",
					text: [
						"You are an expert read-only code analysis agent for the growth-genious repository.",
						"Use the provided tools to inspect source files, related code, and nearby patterns before answering.",
						"Do not propose made-up details. Ground every recommendation in the actual code you inspected.",
						"Do not modify files. You are analysis-only.",
						"When you have enough context, call submit_analysis with a concise review.",
						"Structure the review as: summary, strengths, risks/issues, and recommendations.",
					].join(" "),
				},
			],
		},
	];

	if (contextMarkdown) {
		items.push({
			role: "system",
			content: [
				{
					type: "input_text",
					text: `Project context:\n\n${contextMarkdown}`,
				},
			],
		});
	}

	items.push({
		role: "user",
		content: [
			{
				type: "input_text",
				text: input.request,
			},
		],
	});

	return items;
}