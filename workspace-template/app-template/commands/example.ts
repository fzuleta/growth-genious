import type { PluginCommand } from "../../../src/plugin-contract";

export const exampleCommand: PluginCommand = {
	name: "example",
	description: "Starter app command that proves command routing is wired for the active app.",
	handle: async (input) => {
		return {
			reply: [
				`/${input.plugin.id}:example executed.`,
				`args=${input.args || "none"}`,
				`pluginRoot=${input.pluginRootDir}`,
				`outputDir=${input.outputDir}`,
			].join("\n"),
		};
	},
};