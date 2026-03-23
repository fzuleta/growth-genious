import type { AiProvider, AiTextTask, PluginAiTaskConfig } from "./contracts";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import OpenAI from "openai";
import type { PluginContract } from "../plugin-contract";

export type { AiProvider, AiTextTask, PluginAiTaskConfig } from "./contracts";

type ChatRole = "system" | "user" | "assistant" | "developer" | "tool";

type ChatMessage = {
	role: ChatRole;
	content: string;
	toolCallId?: string;
};

type ResolveCoreTextModel = (env: NodeJS.ProcessEnv) => string;

const CORE_TEXT_MODEL_RESOLVERS: Record<AiTextTask, ResolveCoreTextModel> = {
	"chat": (env) => readEnvValue(env.OPENAI_MODEL) || "gpt-5.4",
	"router": (env) => readEnvValue(env.OPENAI_ROUTER_MODEL) || "gpt-5.4-mini",
	"next-step": (env) => readEnvValue(env.OPENAI_NEXT_STEP_MODEL) || readEnvValue(env.OPENAI_ROUTER_MODEL) || "gpt-5.4-mini",
	"memory": (env) => readEnvValue(env.OPENAI_CHAT_MEMORY_MODEL) || readEnvValue(env.OPENAI_MODEL) || "gpt-5.4",
	"agent": (env) => readEnvValue(env.OPENAI_AGENT_MODEL) || readEnvValue(env.OPENAI_MODEL) || "gpt-4o",
	"analytics-summary": (env) => readEnvValue(env.OPENAI_MODEL) || "gpt-4o",
	"analytics-intent": (env) => readEnvValue(env.OPENAI_ROUTER_MODEL) || "gpt-5.4-mini",
	"analytics-reply": (env) => readEnvValue(env.OPENAI_MODEL) || "gpt-5.4-mini",
};

export interface GenerateTextInput {
	task: AiTextTask;
	input: ResponseInputItem[];
	model?: string;
	plugin?: PluginContract;
}

export interface GenerateTextResult {
	provider: AiProvider;
	model: string;
	text: string;
}

export interface ResolveAiTextTaskOptions {
	env?: NodeJS.ProcessEnv;
	plugin?: PluginContract | null;
	modelOverride?: string;
}

export interface ResolvedAiTextTaskConfig {
	provider: AiProvider;
	model: string;
}

export function resolveAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
	const provider = env.AI_PROVIDER?.trim().toLowerCase();
	if (provider === "openrouter") {
		return "openrouter";
	}

	return "openai";
}

export function resolveAiTextModel(
	task: AiTextTask,
	options: ResolveAiTextTaskOptions = {},
): string {
	return resolveAiTextTaskConfig(task, options).model;
}

export function resolveAiTextTaskConfig(
	task: AiTextTask,
	options: ResolveAiTextTaskOptions = {},
): ResolvedAiTextTaskConfig {
	const env = options.env ?? process.env;
	const pluginConfig = resolvePluginAiTaskConfig(task, options.plugin, env);
	return {
		provider: pluginConfig.provider ?? resolveAiProvider(env),
		model: options.modelOverride ?? pluginConfig.model ?? CORE_TEXT_MODEL_RESOLVERS[task](env),
	};
}

export async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
	const { provider, model } = resolveAiTextTaskConfig(input.task, {
		plugin: input.plugin,
		modelOverride: input.model,
	});

	if (provider === "openrouter") {
		const text = await generateOpenRouterText(model, input.input);
		return { provider, model, text };
	}

	const text = await generateOpenAiText(model, input.input);
	return { provider, model, text };
}

async function generateOpenAiText(model: string, input: ResponseInputItem[]): Promise<string> {
	const apiKey = readEnvValue(process.env.OPENAI_API_KEY);
	if (!apiKey) {
		throw new Error("Missing OPENAI_API_KEY. Set it in the environment or switch AI_PROVIDER.");
	}

	const client = new OpenAI({
		apiKey,
		organization: readEnvValue(process.env.OPENAI_ORG_ID),
		project: readEnvValue(process.env.OPENAI_PROJECT_ID),
	});

	const response = await client.responses.create({
		model,
		input,
	});

	return response.output_text.trim();
}

async function generateOpenRouterText(model: string, input: ResponseInputItem[]): Promise<string> {
	const apiKey = readEnvValue(process.env.OPENROUTER_API_KEY);
	if (!apiKey) {
		throw new Error("Missing OPENROUTER_API_KEY. Set it in the environment when AI_PROVIDER=openrouter.");
	}

	const { OpenRouter, fromChatMessages } = await import("@openrouter/sdk");
	const client = new OpenRouter({
		apiKey,
		httpReferer: readEnvValue(process.env.OPENROUTER_HTTP_REFERER),
		xTitle: readEnvValue(process.env.OPENROUTER_X_TITLE) || "growth-genious",
	});

	const result = client.callModel({
		model,
		input: fromChatMessages(convertResponseInputToChatMessages(input) as Parameters<typeof fromChatMessages>[0]),
	});

	return (await result.getText()).trim();
}

function convertResponseInputToChatMessages(input: ResponseInputItem[]): ChatMessage[] {
	const messages: ChatMessage[] = [];

	for (const item of input) {
		if (isFunctionCallOutput(item)) {
			messages.push({
				role: "tool",
				content: normalizeItemText(item.output),
				toolCallId: item.call_id,
			});
			continue;
		}

		if (!hasRole(item)) {
			continue;
		}

		messages.push({
			role: normalizeRole(item.role),
			content: normalizeItemText(item.content),
		});
	}

	return messages;
}

function hasRole(item: ResponseInputItem): item is ResponseInputItem & { role: string; content: unknown } {
	return typeof item === "object" && item !== null && "role" in item;
}

function isFunctionCallOutput(item: ResponseInputItem): item is ResponseInputItem & { type: "function_call_output"; call_id: string; output: unknown } {
	return typeof item === "object" && item !== null && "type" in item && item.type === "function_call_output";
}

function normalizeRole(role: string): ChatRole {
	if (role === "assistant" || role === "developer" || role === "tool" || role === "user") {
		return role;
	}

	return "system";
}

function normalizeItemText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return content == null ? "" : JSON.stringify(content);
	}

	const parts = content
		.map((part) => {
			if (typeof part === "string") {
				return part;
			}

			if (!part || typeof part !== "object") {
				return "";
			}

			if ("text" in part && typeof part.text === "string") {
				return part.text;
			}

			return JSON.stringify(part);
		})
		.filter((part) => part.length > 0);

	return parts.join("\n");
}

function readEnvValue(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolvePluginAiTaskConfig(
	task: AiTextTask,
	plugin: PluginContract | null | undefined,
	env: NodeJS.ProcessEnv,
): PluginAiTaskConfig {
	const config = plugin?.resolveAiTaskConfig?.(task, env);
	if (!config) {
		return {};
	}

	return {
		provider: config.provider,
		model: config.model?.trim() || undefined,
	};
}