import type { ResponseInputItem } from "openai/resources/responses/responses";
import OpenAI from "openai";

export type AiProvider = "openai" | "openrouter";

export type AiTextTask =
	| "chat"
	| "router"
	| "next-step"
	| "memory"
	| "agent"
	| "analytics-summary"
	| "analytics-intent"
	| "analytics-reply";

type ChatRole = "system" | "user" | "assistant" | "developer" | "tool";

type ChatMessage = {
	role: ChatRole;
	content: string;
	toolCallId?: string;
};

export interface GenerateTextInput {
	task: AiTextTask;
	input: ResponseInputItem[];
	model?: string;
}

export interface GenerateTextResult {
	provider: AiProvider;
	model: string;
	text: string;
}

export function resolveAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
	const provider = env.AI_PROVIDER?.trim().toLowerCase();
	if (provider === "openrouter") {
		return "openrouter";
	}

	return "openai";
}

export function resolveAiTextModel(task: AiTextTask, env: NodeJS.ProcessEnv = process.env): string {
	switch (task) {
		case "chat":
			return readEnvValue(env.OPENAI_MODEL) || "gpt-5.4";
		case "router":
			return readEnvValue(env.OPENAI_ROUTER_MODEL) || "gpt-5.4-mini";
		case "next-step":
			return readEnvValue(env.OPENAI_NEXT_STEP_MODEL) || readEnvValue(env.OPENAI_ROUTER_MODEL) || "gpt-5.4-mini";
		case "memory":
			return readEnvValue(env.OPENAI_CHAT_MEMORY_MODEL) || readEnvValue(env.OPENAI_MODEL) || "gpt-5.4";
		case "agent":
			return readEnvValue(env.OPENAI_AGENT_MODEL) || readEnvValue(env.OPENAI_MODEL) || "gpt-4o";
		case "analytics-summary":
			return readEnvValue(env.OPENAI_ANALYTICS_MODEL) || readEnvValue(env.OPENAI_MODEL) || "gpt-4o";
		case "analytics-intent":
			return readEnvValue(env.OPENAI_NL_ANALYTICS_MODEL) || readEnvValue(env.OPENAI_ROUTER_MODEL) || "gpt-5.4-mini";
		case "analytics-reply":
			return readEnvValue(env.OPENAI_NL_ANALYTICS_REPLY_MODEL)
				|| readEnvValue(env.OPENAI_ANALYTICS_MODEL)
				|| readEnvValue(env.OPENAI_MODEL)
				|| "gpt-5.4-mini";
	}
}

export async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
	const provider = resolveAiProvider();
	const model = input.model ?? resolveAiTextModel(input.task);

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