import type { PluginContract } from "../../src/plugin-contract";
import { getPluginEnvFilePath } from "../../src/runtime-env";
import { exampleCommand } from "./commands/example";

export const examplePlugin: PluginContract = {
	id: "<plugin-id>",
	name: "<Plugin Name>",
	envFilePath: getPluginEnvFilePath("<plugin-id>"),
	rootDir: "src/plugins/<plugin-id>",
	outputDir: "output/<plugin-id>",
	requiredEnv: [],
	commands: [exampleCommand],
	customRoutes: [
		{
			name: "briefing",
			description: "Provide an app-specific briefing when the user asks for a status summary or operational overview.",
			examples: [
				"give me the latest briefing",
				"summarize where things stand for this app",
			],
			subject: "app-briefing",
			requestedSources: ["agent-docs", "top-level-docs"],
			handle: async (input) => {
				return [
					`Custom route '${input.plugin.id}:briefing' executed.`,
					`pluginRoot=${input.pluginRootDir}`,
					`outputDir=${input.outputDir}`,
				].join("\n");
			},
		},
	],
	routeRequest: (input) => {
		if (/^\/briefing(?:\s+.*)?$/i.test(input.content.trim())) {
			return {
				routeName: "briefing",
				subject: "app-briefing",
				confidence: "high",
				requestedSources: ["agent-docs", "top-level-docs"],
				reason: "app-briefing-slash-alias",
				handle: async (handlerInput) => {
					return [
						`Slash alias matched for ${handlerInput.plugin.id}.`,
						`content=${handlerInput.content}`,
					].join("\n");
				},
			};
		}

		return null;
	},
};