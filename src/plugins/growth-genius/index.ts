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
	envFilePath: getPluginEnvFilePath("growth-genius"),
	rootDir: "src/plugins/growth-genius",
	outputDir: "output/growth-genius",
	requiredEnv: [],
	commands: [analyticsCommand],
	routeRequest: async (input) => {
		const intent = await matchNaturalLanguageAnalyticsRequestWithModel(input.content);
		if (!intent) {
			return null;
		}

		return {
			commandName: "analytics",
			routeName: "analytics-natural-language",
			subject: intent.subject,
			confidence: intent.reason.includes("-high") ? "high" : "medium",
			requestedSources: ["google-analytics"],
			reason: intent.reason,
			handle: async (handlerInput) => {
				const result = await executeAnalyticsInvocation(handlerInput, {
					args: intent.args,
					requestSource: "analytics-natural-language",
					originalPrompt: input.content,
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