import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Message } from "discord.js";
import type { ChatRouteConfidence } from "./chat-routing-types";
import type { SmediaMongoDatabase } from "./db/mongo";

export interface PluginRouteRequest {
	content: string;
	channelId: string;
	username: string;
}

export interface PluginCommandResult {
	reply: string;
	outputFiles?: string[];
}

export interface PluginCommandContext {
	plugin: PluginContract;
	database: SmediaMongoDatabase;
	message: Message;
	content: string;
	args: string;
	pluginRootDir: string;
	outputDir: string;
}

export type PluginCommandHandler = (input: PluginCommandContext) => Promise<PluginCommandResult | string>;

export interface PluginCommandMatch {
	subject?: string;
	confidence?: ChatRouteConfidence;
	requestedSources?: string[];
	reason?: string;
	args?: string;
}

export interface PluginCommand {
	name: string;
	description: string;
	requiredEnv?: string[];
	match?: (input: PluginRouteRequest) => PluginCommandMatch | null;
	handle: PluginCommandHandler;
}

export type PluginRouteHandler = (input: PluginCommandContext) => Promise<string>;

export interface PluginCustomRoute {
	name: string;
	description: string;
	examples?: string[];
	subject?: string;
	confidence?: ChatRouteConfidence;
	requestedSources?: string[];
	handle: PluginRouteHandler;
}

export interface PluginRouteMatch {
	commandName?: string;
	routeName?: string;
	subject: string;
	confidence?: ChatRouteConfidence;
	requestedSources?: string[];
	reason?: string;
	handle: PluginRouteHandler;
}

export interface PluginContract {
	id: string;
	name: string;
	discordBotKey?: string;
	envFilePath: string;
	rootDir: string;
	outputDir: string;
	requiredEnv: string[];
	commands: PluginCommand[];
	customRoutes?: PluginCustomRoute[];
	routeRequest?: (input: PluginRouteRequest) => Promise<PluginRouteMatch | null> | PluginRouteMatch | null;
}

export function resolvePluginRootDir(plugin: PluginContract): string {
	return path.resolve(process.cwd(), plugin.rootDir);
}

export function resolvePluginOutputDir(plugin: PluginContract): string {
	return path.resolve(process.cwd(), plugin.outputDir);
}

export async function ensurePluginOutputDir(plugin: PluginContract): Promise<string> {
	const outputDir = resolvePluginOutputDir(plugin);
	await mkdir(outputDir, { recursive: true });
	return outputDir;
}

export function getMissingEnvVars(requiredEnv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
	return requiredEnv.filter((name) => !env[name]?.trim());
}

export function resolvePluginRouteMatch(plugin: PluginContract, input: PluginRouteRequest): PluginRouteMatch | null {
	for (const command of plugin.commands) {
		const match = command.match?.(input) ?? matchSlashCommand(input.content, command.name);
		if (!match) {
			continue;
		}

		const args = match.args?.trim() ?? "";
		return {
			commandName: command.name,
			subject: match.subject?.trim() || command.name,
			confidence: match.confidence ?? "high",
			requestedSources: match.requestedSources ?? [],
			reason: match.reason?.trim() || "plugin-command-match",
			handle: async (handlerInput) => {
				const outputDir = await ensurePluginOutputDir(plugin);
				const missingEnv = getMissingEnvVars([...plugin.requiredEnv, ...(command.requiredEnv ?? [])]);
				if (missingEnv.length > 0) {
					return [
						`/${command.name} is configured for ${plugin.id}, but it cannot run yet.`,
						`missingEnv=${missingEnv.join(",")}`,
						`pluginRoot=${plugin.rootDir}`,
						`outputDir=${plugin.outputDir}`,
					].join("\n");
				}

				const result = await command.handle({
					...handlerInput,
					plugin,
					args,
					pluginRootDir: resolvePluginRootDir(plugin),
					outputDir,
				});
				return formatPluginCommandResult(plugin, command.name, outputDir, result);
			},
		};
	}

	return null;
}

export function listPluginCustomRoutes(plugin: PluginContract): PluginCustomRoute[] {
	return plugin.customRoutes ?? [];
}

export function resolvePluginCustomRouteByName(plugin: PluginContract, routeName: string): PluginRouteMatch | null {
	const normalizedRouteName = routeName.trim().toLowerCase();
	if (!normalizedRouteName) {
		return null;
	}

	const route = listPluginCustomRoutes(plugin).find((value) => value.name.trim().toLowerCase() === normalizedRouteName);
	if (!route) {
		return null;
	}

	return {
		routeName: route.name,
		subject: route.subject?.trim() || route.name,
		confidence: route.confidence ?? "high",
		requestedSources: route.requestedSources ?? [],
		reason: "plugin-custom-route-declared",
		handle: route.handle,
	};
}

function matchSlashCommand(content: string, commandName: string): PluginCommandMatch | null {
	const normalizedCommand = `/${commandName.trim().toLowerCase()}`;
	const trimmedContent = content.trim();
	const normalizedContent = trimmedContent.toLowerCase();

	if (normalizedContent === normalizedCommand) {
		return {
			subject: commandName,
			args: "",
			reason: "slash-command-exact-match",
		};
	}

	if (normalizedContent.startsWith(`${normalizedCommand} `)) {
		return {
			subject: commandName,
			args: trimmedContent.slice(normalizedCommand.length).trim(),
			reason: "slash-command-prefix-match",
		};
	}

	return null;
}

function formatPluginCommandResult(plugin: PluginContract, commandName: string, outputDir: string, result: PluginCommandResult | string): string {
	if (typeof result === "string") {
		return result;
	}

	const outputFiles = result.outputFiles?.filter((value) => value.trim().length > 0) ?? [];
	if (outputFiles.length === 0) {
		return result.reply;
	}

	return [
		result.reply,
		`command=/${commandName}`,
		`plugin=${plugin.id}`,
		`outputDir=${path.relative(process.cwd(), outputDir) || plugin.outputDir}`,
		`outputFiles=${outputFiles.join(",")}`,
	].join("\n");
}