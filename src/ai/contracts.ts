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

export interface PluginAiTaskConfig {
	provider?: AiProvider;
	model?: string;
}

export type ResolvePluginAiTaskConfig = (task: AiTextTask, env?: NodeJS.ProcessEnv) => PluginAiTaskConfig | undefined;