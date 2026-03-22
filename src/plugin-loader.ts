import type { PluginContract } from "./plugin-contract";
import { builtinPlugins, getBuiltinPluginById } from "./plugins";
import { assertSinglePluginConfiguration, readActivePluginId } from "./runtime-env";

export function loadCurrentPlugin(env: NodeJS.ProcessEnv = process.env): PluginContract {
	assertSinglePluginConfiguration(env);
	const activePluginId = readActivePluginId(env);
	const plugin = getBuiltinPluginById(activePluginId);

	if (!plugin) {
		throw new Error(`Unsupported PLUGIN_ID '${activePluginId}'. Add a plugin module before starting the bot.`);
	}

	const discordBotKey = env.DISCORD_BOT_KEY?.trim();
	if (!discordBotKey) {
		throw new Error("Missing DISCORD_BOT_KEY. It can be defined in .env or in the active plugin env file.");
	}

	return {
		...plugin,
		discordBotKey,
	};
}

export function listAvailablePlugins(): PluginContract[] {
	return [...builtinPlugins];
}