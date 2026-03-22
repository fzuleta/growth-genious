import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { PluginContract, PluginRouteHandler, PluginRouteMatch } from "./plugin-contract";
import type { ChatRouteDecision } from "./chat-routing-types";
import { logWarn } from "./helpers/log";
import { createOpenAIClient } from "./openai/openai";
import { listPluginCustomRoutes, resolvePluginCustomRouteByName, resolvePluginRouteMatch } from "./plugin-contract";

const DEFAULT_ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL?.trim() || "gpt-5.4-mini";
const DIRECT_CONVERSATION_MAX_LENGTH = 24;

export interface ChatRouteClassificationResult {
	decision: ChatRouteDecision;
	model: string;
	promptInput: ResponseInputItem[];
	customRouteHandler: PluginRouteHandler | null;
}

export async function classifyChatRoute(input: {
	content: string;
	channelId: string;
	username: string;
	plugin?: PluginContract;
}): Promise<ChatRouteClassificationResult> {
	const normalizedContent = input.content.trim();
	const promptInput = await buildChatRoutePromptInput({
		channelId: input.channelId,
		username: input.username,
		content: normalizedContent,
		plugin: input.plugin,
	});

	if (!normalizedContent) {
		return {
			decision: buildFallbackDecision("conversation", normalizedContent, "empty-content"),
			model: DEFAULT_ROUTER_MODEL,
			promptInput,
			customRouteHandler: null,
		};
	}

	const customRouteMatch = await resolveCustomRouteMatch(input.plugin, {
		content: normalizedContent,
		channelId: input.channelId,
		username: input.username,
	});
	if (customRouteMatch) {
		return {
			decision: buildCustomRouteDecision(customRouteMatch, normalizedContent),
			model: DEFAULT_ROUTER_MODEL,
			promptInput,
			customRouteHandler: customRouteMatch.handle,
		};
	}

	const heuristicDecision = classifyWithHeuristics(normalizedContent);
	if (heuristicDecision) {
		const enriched = await enrichDecisionWithThemeResolver(heuristicDecision, normalizedContent);
		return {
			decision: enriched,
			model: DEFAULT_ROUTER_MODEL,
			promptInput,
			customRouteHandler: null,
		};
	}

	try {
		const client = createOpenAIClient();
		const response = await client.responses.create({
			model: DEFAULT_ROUTER_MODEL,
			input: promptInput,
		});

		const llmDecision = parseClassifierOutput(response.output_text, normalizedContent);
		const enriched = await enrichDecisionWithThemeResolver(llmDecision, normalizedContent);
		const declaredCustomRoute = resolveDeclaredCustomRoute(input.plugin, enriched, {
			content: normalizedContent,
			channelId: input.channelId,
			username: input.username,
		});
		if (declaredCustomRoute) {
			return {
				decision: buildCustomRouteDecision(declaredCustomRoute, normalizedContent),
				model: DEFAULT_ROUTER_MODEL,
				promptInput,
				customRouteHandler: declaredCustomRoute.handle,
			};
		}

		if (enriched.route === "custom") {
			return {
				decision: buildFallbackDecision("conversation", normalizedContent, "unknown-plugin-custom-route"),
				model: DEFAULT_ROUTER_MODEL,
				promptInput,
				customRouteHandler: null,
			};
		}

		return {
			decision: enriched,
			model: DEFAULT_ROUTER_MODEL,
			promptInput,
			customRouteHandler: null,
		};
	} catch (error: unknown) {
		logWarn("Chat route classification failed; falling back to conversation", {
			channelId: input.channelId,
			username: input.username,
			message: error instanceof Error ? error.message : String(error),
		});
		return {
			decision: buildFallbackDecision("conversation", normalizedContent, "classifier-error"),
			model: DEFAULT_ROUTER_MODEL,
			promptInput,
			customRouteHandler: null,
		};
	}
}

export function getChatRouterModel(): string {
	return DEFAULT_ROUTER_MODEL;
}

async function buildChatRoutePromptInput(input: {
	channelId: string;
	username: string;
	content: string;
	plugin?: PluginContract;
}): Promise<ResponseInputItem[]> {
	const pluginCustomRoutes = input.plugin ? listPluginCustomRoutes(input.plugin) : [];
	return [
		{
			role: "system",
			content: [
				{
					type: "input_text",
					text: [
						"You classify a Discord message into one of six routes.",
						"Return strict JSON only with keys route, confidence, subject, requestedSources, entityHints, reason.",
						"Allowed route values: conversation, db-query, workspace-question, self-modify, code-analysis, custom.",
						"Use db-query whenever the answer likely depends on MongoDB-backed history, jobs, prior chat, memory, prior bot actions, user-specific history, or anything about what happened before.",
						"Use workspace-question for repository docs, workspace templates, configuration, source tree layout, or other repository facts that need retrieval.",
						"Use code-analysis when the user wants you to inspect source code, review an implementation, analyze a file, or provide recommendations without modifying code.",
						"Use self-modify when the user is asking the bot to write code, implement features, fix bugs, refactor source files, add plugin support, or make any change to the codebase itself.",
						pluginCustomRoutes.length > 0
							? "Use custom when the message clearly matches one of the active plugin custom routes. When you do, set entityHints.customRouteName to the exact declared route name."
							: "Only use custom when the active plugin explicitly exposes a custom route.",
						"Use conversation for general chat, brainstorming, or anything not requiring retrieval or code changes.",
						"For db-query, prefer broad retrieval when uncertain rather than falling back too early.",
						"entityHints must be an object with optional jobId, optional modelId, optional fileHint, optional customRouteName, optional selfModifyIntent (brief description of the requested code change), and topicKeywords as an array of short strings.",
						pluginCustomRoutes.length > 0 ? formatPluginCustomRouteInstructions(pluginCustomRoutes) : "",
						"Do not answer the user. Do not include markdown. Keep subject short and concrete.",
				].filter(Boolean).join(" "),
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "input_text",
					text: JSON.stringify({
						channelId: input.channelId,
						username: input.username,
						message: input.content,
					}),
				},
			],
		},
	];
}

async function enrichDecisionWithThemeResolver(
	decision: ChatRouteDecision,
	_content: string,
): Promise<ChatRouteDecision> {
	return decision;
}

async function resolveCustomRouteMatch(
	plugin: PluginContract | undefined,
	input: {
		content: string;
		channelId: string;
		username: string;
	},
): Promise<PluginRouteMatch | null> {
	if (!plugin) {
		return null;
	}

	try {
		const commandMatch = resolvePluginRouteMatch(plugin, input);
		if (commandMatch) {
			return commandMatch;
		}

		return (await plugin.routeRequest?.(input)) ?? null;
	} catch (error: unknown) {
		logWarn("Custom route callback failed; continuing with default router", {
			channelId: input.channelId,
			username: input.username,
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function classifyWithHeuristics(content: string): ChatRouteDecision | null {
	const normalized = content.trim().toLowerCase();
	if (normalized.length <= DIRECT_CONVERSATION_MAX_LENGTH && /^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|yo)[!.? ]*$/i.test(normalized)) {
		return buildFallbackDecision("conversation", content, "short-greeting");
	}

	if (
		(
			/(analy[sz]e|review|inspect|look at|recommendations|recommend improvements|code review|feedback on|what do you think of|assess)/i.test(content) ||
			(/(suggest|idea|variation|complement|complementary)/i.test(content) && /(based on|using|from)/i.test(content))
		) &&
		/(src\/|\.ts\b|implementation|plugin|function|class|file|directory|folder)/i.test(content)
	) {
		return {
			route: "code-analysis",
			confidence: "high",
			subject: "source-analysis",
			requestedSources: [],
			entityHints: {
				fileHint: inferSourceFileHint(content),
				topicKeywords: buildTopicKeywords(content),
			},
			reason: "code-analysis-keyword-match",
		};
	}

	if (/(implement|add feature|create a new|refactor|fix bug|modify code|change the code|update the code|write code|edit the source|patch the|add support for|plugin system)/i.test(content)) {
		return {
			route: "self-modify",
			confidence: "high",
			subject: "code-modification",
			requestedSources: [],
			entityHints: {
				topicKeywords: buildTopicKeywords(content),
				selfModifyIntent: content.trim(),
			},
			reason: "self-modify-keyword-match",
		};
	}

	if (/(what happened|last job|previous job|job status|job id|run id|failed job|latest job)/i.test(content)) {
		return {
			route: "db-query",
			confidence: "high",
			subject: "recent-job",
			requestedSources: ["generation-jobs"],
			entityHints: {
				topicKeywords: buildTopicKeywords(content),
			},
			reason: "job-keyword-match",
		};
	}

	if (/(what did we talk|previous conversation|earlier conversation|remember about me|memory|what do you remember|previous messages|chat history)/i.test(content)) {
		return {
			route: "db-query",
			confidence: "high",
			subject: "conversation-history",
			requestedSources: ["chat-messages", "memory-entries"],
			entityHints: {
				topicKeywords: buildTopicKeywords(content),
			},
			reason: "history-keyword-match",
		};
	}

	if (/(readme|repo docs|documentation|workspace|workspace-template|context\.md|project structure|folder structure|plugin)/i.test(content)) {
		return {
			route: "workspace-question",
			confidence: "medium",
			subject: "workspace-docs",
			requestedSources: ["agent-docs", "top-level-docs", "workspace-template"],
			entityHints: {
				fileHint: inferFileHint(content),
				topicKeywords: buildTopicKeywords(content),
			},
			reason: "workspace-keyword-match",
		};
	}

	return null;
}

function buildCustomRouteDecision(match: PluginRouteMatch, content: string): ChatRouteDecision {
	return {
		route: "custom",
		confidence: match.confidence ?? "high",
		subject: match.subject.trim(),
		requestedSources: Array.isArray(match.requestedSources)
			? match.requestedSources.filter((value) => value.trim().length > 0).slice(0, 5)
			: [],
		entityHints: {
			fileHint: inferFileHint(content),
			customCommandName: match.commandName?.trim() || undefined,
			customRouteName: match.routeName?.trim() || undefined,
			topicKeywords: buildTopicKeywords(content),
		},
		reason: match.reason?.trim() || "custom-route-callback",
	};
}

function parseClassifierOutput(outputText: string, fallbackContent: string): ChatRouteDecision {
	const jsonText = stripJsonCodeFence(outputText.trim());

	try {
		const parsed = JSON.parse(jsonText) as Partial<ChatRouteDecision> & {
			entityHints?: Partial<ChatRouteDecision["entityHints"]>;
		};
		const route =
			parsed.route === "db-query" || parsed.route === "workspace-question" || parsed.route === "conversation" || parsed.route === "self-modify" || parsed.route === "code-analysis" || parsed.route === "custom"
				? parsed.route
				: "conversation";
		const confidence =
			parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
				? parsed.confidence
				: "low";

		if (confidence === "low") {
			return buildFallbackDecision("conversation", fallbackContent, "low-confidence");
		}

		const topicKeywords = Array.isArray(parsed.entityHints?.topicKeywords)
			? parsed.entityHints.topicKeywords
					.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0)
					.slice(0, 6)
			: buildTopicKeywords(fallbackContent);

		return {
			route,
			confidence,
			subject: typeof parsed.subject === "string" && parsed.subject.trim().length > 0 ? parsed.subject.trim() : route,
			requestedSources: Array.isArray(parsed.requestedSources)
				? parsed.requestedSources.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 5)
				: [],
			entityHints: {
				jobId: typeof parsed.entityHints?.jobId === "string" ? parsed.entityHints.jobId.trim() : undefined,
				modelId:
					typeof parsed.entityHints?.modelId === "string"
						? parsed.entityHints.modelId.trim()
						: extractModelId(fallbackContent) ?? undefined,
				fileHint:
					typeof parsed.entityHints?.fileHint === "string"
						? parsed.entityHints.fileHint.trim()
						: inferFileHint(fallbackContent),
				customCommandName:
					typeof parsed.entityHints?.customCommandName === "string"
						? parsed.entityHints.customCommandName.trim()
						: undefined,
				customRouteName:
					typeof parsed.entityHints?.customRouteName === "string"
						? parsed.entityHints.customRouteName.trim()
						: undefined,
				topicKeywords,
				selfModifyIntent:
					typeof parsed.entityHints?.selfModifyIntent === "string"
						? parsed.entityHints.selfModifyIntent.trim()
						: undefined,
			},
			reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
		};
	} catch {
		return buildFallbackDecision("conversation", fallbackContent, "invalid-json");
	}
}

function stripJsonCodeFence(text: string): string {
	if (!text.startsWith("```")) {
		return text;
	}

	return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function buildFallbackDecision(route: ChatRouteDecision["route"], content: string, reason: string): ChatRouteDecision {
	return {
		route,
		confidence: route === "conversation" ? "medium" : "low",
		subject: route,
		requestedSources: [],
		entityHints: {
			modelId: extractModelId(content) ?? undefined,
			fileHint: inferFileHint(content),
			topicKeywords: buildTopicKeywords(content),
		},
		reason,
	};
}

function resolveDeclaredCustomRoute(
	plugin: PluginContract | undefined,
	decision: ChatRouteDecision,
	input: {
		content: string;
		channelId: string;
		username: string;
	},
): PluginRouteMatch | null {
	if (!plugin || decision.route !== "custom") {
		return null;
	}

	const routeName = decision.entityHints.customRouteName?.trim() || decision.subject.trim();
	if (!routeName) {
		return null;
	}

	try {
		return resolvePluginCustomRouteByName(plugin, routeName);
	} catch (error: unknown) {
		logWarn("Plugin custom route resolution failed; falling back to conversation", {
			channelId: input.channelId,
			username: input.username,
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function formatPluginCustomRouteInstructions(routes: ReturnType<typeof listPluginCustomRoutes>): string {
	return [
		"Active plugin custom routes:",
		...routes.map((route) => {
			const examples = route.examples?.filter((value) => value.trim().length > 0) ?? [];
			return examples.length > 0
				? `${route.name}: ${route.description}. Examples: ${examples.join(" | ")}.`
				: `${route.name}: ${route.description}.`;
		}),
	].join(" ");
}

function extractModelId(content: string): string | null {
	const match = content.match(/\bff\d{3}-[a-z0-9-]+\b/i);
	return match ? match[0].toLowerCase() : null;
}

function inferFileHint(content: string): string | undefined {
	const sourceFileHint = inferSourceFileHint(content);
	if (sourceFileHint) {
		return sourceFileHint;
	}

	if (/art style|art-style/i.test(content)) {
		return "art-style.md";
	}
	if (/sound/i.test(content)) {
		return "sound_instructions.md";
	}
	if (/logo/i.test(content)) {
		return "logo.md";
	}
	if (/game\.json|json|metadata/i.test(content)) {
		return "game.json";
	}
	if (/readme/i.test(content)) {
		return "README.md";
	}
	return undefined;
}

function inferSourceFileHint(content: string): string | undefined {
	const match = content.match(/(?:^|\s)(src\/[A-Za-z0-9._/-]+\.ts)\b/);
	return match ? match[1] : undefined;
}

function buildTopicKeywords(content: string): string[] {
	return Array.from(
		new Set(
			content
				.toLowerCase()
				.split(/[^a-z0-9.-]+/)
				.map((part) => part.trim())
				.filter((part) => part.length >= 3),
		),
	).slice(0, 6);
}