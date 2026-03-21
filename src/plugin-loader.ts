import type { PluginContract } from "./plugin-contract";
import { builtinPlugins, getBuiltinPluginById } from "./plugins";
import { readActivePluginId, readEnabledPluginIds } from "./runtime-env";

export function loadCurrentPlugin(env: NodeJS.ProcessEnv = process.env): PluginContract {
	const activePluginId = readActivePluginId(env);
	const enabledPluginIds = readEnabledPluginIds(env, builtinPlugins.map((plugin) => plugin.id));
	const plugin = getBuiltinPluginById(activePluginId);

	if (!plugin) {
		throw new Error(`Unsupported PLUGIN_ID '${activePluginId}'. Add a plugin module before starting the bot.`);
	}

	if (!enabledPluginIds.includes(plugin.id)) {
		throw new Error(`Plugin '${plugin.id}' is not enabled. Enabled plugins: ${enabledPluginIds.join(", ") || "none"}.`);
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