import type { PluginContract } from "../plugin-contract";
import { growthGeniusPlugin } from "./growth-genius";

export const builtinPlugins: PluginContract[] = [growthGeniusPlugin];

export function getBuiltinPluginById(pluginId: string): PluginContract | null {
	return builtinPlugins.find((plugin) => plugin.id === pluginId) ?? null;
}