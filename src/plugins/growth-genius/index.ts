import type { PluginContract } from "../../plugin-contract";
import { getPluginEnvFilePath } from "../../runtime-env";
import {
	analyticsCommand,
	executeAnalyticsInvocation,
	formatAnalyticsCommandResult,
	matchNaturalLanguageAnalyticsRequestWithModel,
} from "./commands/analytics";

export const growthGeniusPlugin: PluginContract = {
	id: "growth-genius",
	name: "Growth Genius",
	resolveAiTaskConfig: (task, env = process.env) => {
		switch (task) {
			case "agent":
				return { provider: "openai", model: env.OPENAI_AGENT_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-4o" };
			case "analytics-summary":
				return { model: env.OPENAI_ANALYTICS_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-4o" };
			case "analytics-intent":
				return { model: env.OPENAI_NL_ANALYTICS_MODEL?.trim() || env.OPENAI_ROUTER_MODEL?.trim() || "gpt-5.4-mini" };
			case "analytics-reply":
				return { model: env.OPENAI_NL_ANALYTICS_REPLY_MODEL?.trim() || env.OPENAI_ANALYTICS_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-5.4-mini" };
			default:
				return undefined;
		}
	},
	envFilePath: getPluginEnvFilePath("growth-genius"),
	rootDir: "src/plugins/growth-genius",
	outputDir: "output/growth-genius",
	requiredEnv: [],
	commands: [analyticsCommand],
	routeRequest: async (input) => {
		const intent = await matchNaturalLanguageAnalyticsRequestWithModel(input.content, growthGeniusPlugin);
		if (!intent) {
			return null;
		}

		return {
			commandName: "analytics",
			routeName: "analytics-natural-language",
			subject: intent.subject,
			confidence: intent.confidence === "high" ? "high" : "medium",
			requestedSources: ["google-analytics"],
			reason: intent.reason,
			handle: async (handlerInput) => {
				const result = await executeAnalyticsInvocation(handlerInput, {
					args: intent.args,
					requestSource: "analytics-natural-language",
					originalPrompt: input.content,
					nlIntent: intent,
				});

				return formatAnalyticsCommandResult({
					pluginId: handlerInput.plugin.id,
					commandName: "analytics",
					outputDir: handlerInput.outputDir,
					result,
				});
			},
		};
	},
};