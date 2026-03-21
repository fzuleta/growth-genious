import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const DEFAULT_PLUGIN_ID = "growth-genius";

export interface RuntimeEnvLoadResult {
	pluginId: string;
	baseEnvPath: string;
	pluginEnvPath: string;
	pluginEnvLoaded: boolean;
}

export function loadRuntimeEnv(): RuntimeEnvLoadResult {
	const baseEnvPath = path.resolve(process.cwd(), ".env");
	dotenv.config({ path: baseEnvPath });

	const pluginId = readActivePluginId(process.env);
	const pluginEnvPath = path.resolve(process.cwd(), getPluginEnvFilePath(pluginId));
	const pluginResult = dotenv.config({ path: pluginEnvPath, override: true });

	return {
		pluginId,
		baseEnvPath,
		pluginEnvPath,
		pluginEnvLoaded: !pluginResult.error,
	};
}

export function readActivePluginId(env: NodeJS.ProcessEnv = process.env): string {
	const pluginId = env.PLUGIN_ID?.trim() || env.APP_ID?.trim();
	return pluginId && pluginId.length > 0 ? pluginId : DEFAULT_PLUGIN_ID;
}

export function readEnabledPluginIds(
	env: NodeJS.ProcessEnv = process.env,
	availablePluginIds: string[] = [],
): string[] {
	const rawValue = env.ENABLED_PLUGINS?.trim();
	if (!rawValue) {
		return availablePluginIds.length > 0 ? [...availablePluginIds] : [readActivePluginId(env)];
	}

	const values = rawValue
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);

	return values.length > 0 ? Array.from(new Set(values)) : [readActivePluginId(env)];
}

export function getPluginEnvFilePath(pluginId: string): string {
	const appsDir = path.resolve(process.cwd(), "apps");
	const preferredNested = path.join("apps", pluginId, `${pluginId}.env`);
	if (existsSync(path.resolve(process.cwd(), preferredNested))) {
		return preferredNested;
	}

	const nestedCandidates = existsSync(appsDir)
		? readdirSync(appsDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.flatMap((entry) => {
					const pluginDir = path.join(appsDir, entry.name);
					const exactFile = path.join("apps", entry.name, `${pluginId}.env`);
					const genericCandidates = readdirSync(pluginDir, { withFileTypes: true })
						.filter((child) => child.isFile() && child.name.endsWith(".env"))
						.map((child) => path.join("apps", entry.name, child.name));
					return [exactFile, ...genericCandidates];
				})
		: [];

	for (const candidate of nestedCandidates) {
		if (existsSync(path.resolve(process.cwd(), candidate))) {
			return candidate;
		}
	}

	return path.join("apps", `${pluginId}.env`);
}