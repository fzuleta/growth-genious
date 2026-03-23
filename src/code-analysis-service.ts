import type { ResponseInputItem } from "openai/resources/responses/responses";
import { runAgentLoop } from "./ai/agent-runtime";
import { readOptionalContextMarkdown } from "./context-service";
import { logInfo } from "./helpers/log";
import { getBuiltinPluginById } from "./plugins";

const MAX_ANALYSIS_ITERATIONS = 20;

export async function runCodeAnalysis(input: {
	request: string;
	username: string;
	channelId: string;
	pluginId?: string;
}): Promise<string> {
	const plugin = input.pluginId ? getBuiltinPluginById(input.pluginId) : null;
	const contextMarkdown = await readOptionalContextMarkdown();
	const conversationItems: ResponseInputItem[] = buildAnalysisPrompt(input, contextMarkdown);
	const result = await runAgentLoop({
		task: "agent",
		plugin,
		conversationItems,
		toolSet: "analysis",
		maxIterations: MAX_ANALYSIS_ITERATIONS,
	});

	logInfo("Code-analysis completed", {
		provider: result.provider,
		model: result.model,
		channelId: input.channelId,
		username: input.username,
	});

	return result.output || "I inspected the code but could not produce a grounded analysis within the iteration limit.";
}

function buildAnalysisPrompt(
	input: {
		request: string;
		username: string;
		channelId: string;
		pluginId?: string;
	},
	contextMarkdown: string | null,
): ResponseInputItem[] {
	const pluginLabel = resolvePluginLabel(input.pluginId);
	const items: ResponseInputItem[] = [
		{
			role: "system",
			content: [
				{
					type: "input_text",
					text: [
						`You are an expert read-only code analysis agent for the ${pluginLabel}.`,
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

function resolvePluginLabel(pluginId?: string): string {
	if (!pluginId) {
		return "active app repository";
	}

	const plugin = getBuiltinPluginById(pluginId);
	if (!plugin) {
		return `plugin '${pluginId}' repository`;
	}

	return `${plugin.name} repository`;
}