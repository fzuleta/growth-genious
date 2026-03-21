import type { PluginContract } from "../../plugin-contract";
import { getPluginEnvFilePath } from "../../runtime-env";
import { analyticsCommand } from "./commands/analytics";

export const growthGeniusPlugin: PluginContract = {
	id: "growth-genius",
	name: "Growth Genius",
	envFilePath: getPluginEnvFilePath("growth-genius"),
	rootDir: "src/plugins/growth-genius",
	outputDir: "output/growth-genius",
	requiredEnv: [],
	commands: [analyticsCommand],
};