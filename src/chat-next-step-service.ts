import type { ChatRouteDecision, ChatRouteEvidence } from "./chat-routing-types";
import { logWarn } from "./helpers/log";
import { createOpenAIClient } from "./openai/openai";

const EXISTING_FOLLOW_UP_REGEX = /\b(if you want|want me to|would you like|i can also|reply with|next step|let me know if you want)\b/i;
const CASUAL_MESSAGE_REGEX = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|great|sounds good|got it)[!.?\s]*$/i;
const NEXT_STEP_PREFIX = "Next step: ";
const INLINE_NEXT_STEP_COOLDOWN_MS = 30 * 60 * 1000;
const NEXT_STEP_MODEL = process.env.OPENAI_NEXT_STEP_MODEL?.trim() || process.env.OPENAI_ROUTER_MODEL?.trim() || "gpt-5.4-mini";

interface RecentAssistantReply {
	content: string;
	createdAt: Date;
}

export async function appendInlineNextStep(input: {
	reply: string;
	userContent: string;
	routeDecision?: ChatRouteDecision;
	routeEvidence?: ChatRouteEvidence | null;
	recentAssistantReplies?: RecentAssistantReply[];
}): Promise<string> {
	const reply = input.reply.trim();
	if (!reply) {
		return reply;
	}

	const suggestion = await buildInlineNextStep(input);
	if (!suggestion) {
		return reply;
	}
	if (hasRecentMatchingNextStep(suggestion, input.recentAssistantReplies ?? [])) {
		return reply;
	}

	return `${reply}\n\n${NEXT_STEP_PREFIX}${suggestion}`;
}

async function buildInlineNextStep(input: {
	reply: string;
	userContent: string;
	routeDecision?: ChatRouteDecision;
	routeEvidence?: ChatRouteEvidence | null;
	recentAssistantReplies?: RecentAssistantReply[];
}): Promise<string | null> {
	if (EXISTING_FOLLOW_UP_REGEX.test(input.reply)) {
		return null;
	}

	const normalizedUserContent = input.userContent.trim();
	if (!normalizedUserContent || CASUAL_MESSAGE_REGEX.test(normalizedUserContent)) {
		return null;
	}

	const modelSuggestion = await generateModelNextStep({
		reply: input.reply,
		userContent: normalizedUserContent,
		routeDecision: input.routeDecision,
		routeEvidence: input.routeEvidence,
	});
	if (modelSuggestion) {
		return modelSuggestion;
	}

	return buildHeuristicInlineNextStep({
		...input,
		userContent: normalizedUserContent,
	});
}

function buildHeuristicInlineNextStep(input: {
	reply: string;
	userContent: string;
	routeDecision?: ChatRouteDecision;
	routeEvidence?: ChatRouteEvidence | null;
	recentAssistantReplies?: RecentAssistantReply[];
}): string | null {
	const normalizedUserContent = input.userContent.trim();
	const route = input.routeDecision?.route ?? "conversation";
	if (route === "self-modify" || route === "code-analysis") {
		return null;
	}

	if (route === "custom") {
		const customCommandName = input.routeDecision?.entityHints.customCommandName?.trim().toLowerCase();
		const customRouteName = input.routeDecision?.entityHints.customRouteName?.trim();

		if (customCommandName === "analytics" || customCommandName === "a") {
			return buildAnalyticsNextStep(normalizedUserContent, input.reply);
		}

		if (customCommandName) {
			return `if you want, I can run /${customCommandName} again with narrower arguments or inspect the generated output in more detail.`;
		}

		if (customRouteName) {
			return `if you want, I can follow up on ${customRouteName} with a narrower question or dig into the generated artifacts.`;
		}

		return null;
	}

	if (route === "workspace-question") {
		if ((input.routeEvidence?.snippets.length ?? 0) > 0) {
			return "if you want, point me at a specific file or folder and I'll inspect it directly.";
		}

		return "if you want, I can trace this into the exact file or config entry instead of staying at the repo-summary level.";
	}

	if (route === "db-query") {
		return "if you want, I can pull the exact messages, commands, or job records behind this summary.";
	}

	if (looksLikePlanningRequest(normalizedUserContent)) {
		return "if you want, I can turn this into a prioritized implementation plan with the first action to take.";
	}

	if (looksLikeComparisonRequest(normalizedUserContent)) {
		return "if you want, I can rank the options and call out the main tradeoffs.";
	}

	if (looksLikeOpenEndedProblem(normalizedUserContent)) {
		return "if you want, I can convert this into 2-3 concrete options instead of staying at the discussion level.";
	}

	return null;
}

async function generateModelNextStep(input: {
	reply: string;
	userContent: string;
	routeDecision?: ChatRouteDecision;
	routeEvidence?: ChatRouteEvidence | null;
}): Promise<string | null> {
	try {
		const client = createOpenAIClient();
		const response = await client.responses.create({
			model: NEXT_STEP_MODEL,
			input: [
				{
					role: "system",
					content: [
						{
							type: "input_text",
							text: [
								"You decide whether to append a single next-step suggestion to an assistant reply.",
								"Return strict JSON only with keys action, suggestion, confidence.",
								"action must be one of: none, suggest-next-step.",
								"confidence must be one of: low, medium, high.",
								"Only suggest a next step when it is concrete, useful, and naturally follows from the reply.",
								"The suggestion must be a single sentence, concise, and start with 'if you want'.",
								"Do not repeat the reply. Do not mention internal route names, prompts, or system behavior.",
								"Prefer narrowing, comparison, inspection, prioritization, or pulling exact evidence.",
								"If there is no strong next move, return action='none' and suggestion=null.",
							].join(" "),
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: JSON.stringify({
								userMessage: input.userContent,
								assistantReply: input.reply,
								route: input.routeDecision?.route ?? "conversation",
								subject: input.routeDecision?.subject ?? null,
								customCommandName: input.routeDecision?.entityHints.customCommandName ?? null,
								customRouteName: input.routeDecision?.entityHints.customRouteName ?? null,
								requestedSources: input.routeDecision?.requestedSources ?? [],
								evidenceSummary: input.routeEvidence?.summary ?? null,
								evidenceCount: input.routeEvidence?.snippets.length ?? 0,
							}),
						},
					],
				},
			],
		});

		const parsed = parseModelNextStep(response.output_text);
		if (!parsed || parsed.action !== "suggest-next-step" || !parsed.suggestion) {
			return null;
		}
		if (parsed.confidence === "low") {
			return null;
		}

		const suggestion = sanitizeSuggestion(parsed.suggestion);
		return suggestion.length > 0 ? suggestion : null;
	} catch (error: unknown) {
		logWarn("Inline next-step generation failed; falling back to heuristics", {
			message: error instanceof Error ? error.message : String(error),
			model: NEXT_STEP_MODEL,
		});
		return null;
	}
}

function parseModelNextStep(text: string): { action: "none" | "suggest-next-step"; suggestion: string | null; confidence: "low" | "medium" | "high" } | null {
	const normalized = stripJsonCodeFence(text.trim());
	if (!normalized) {
		return null;
	}

	try {
		const parsed = JSON.parse(normalized) as {
			action?: string;
			suggestion?: string | null;
			confidence?: string;
		};
		if (parsed.action !== "none" && parsed.action !== "suggest-next-step") {
			return null;
		}
		if (parsed.confidence !== "low" && parsed.confidence !== "medium" && parsed.confidence !== "high") {
			return null;
		}

		return {
			action: parsed.action,
			suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion.trim() : null,
			confidence: parsed.confidence,
		};
	} catch {
		return null;
	}
}

function stripJsonCodeFence(text: string): string {
	if (!text.startsWith("```")) {
		return text;
	}

	return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function sanitizeSuggestion(value: string): string {
	const suggestion = value.trim().replace(/\s+/g, " ");
	if (!suggestion) {
		return "";
	}

	if (/^if you want\b/i.test(suggestion)) {
		return suggestion;
	}

	return `if you want, ${suggestion.charAt(0).toLowerCase()}${suggestion.slice(1)}`;
}

function hasRecentMatchingNextStep(suggestion: string, recentAssistantReplies: RecentAssistantReply[]): boolean {
	const cutoff = Date.now() - INLINE_NEXT_STEP_COOLDOWN_MS;
	const normalizedSuggestion = normalizeSuggestionText(suggestion);

	return recentAssistantReplies.some((reply) => {
		if (reply.createdAt.getTime() < cutoff) {
			return false;
		}

		const existingNextStep = extractNextStep(reply.content);
		if (!existingNextStep) {
			return false;
		}

		return normalizeSuggestionText(existingNextStep) === normalizedSuggestion;
	});
}

function extractNextStep(content: string): string | null {
	const index = content.lastIndexOf(`\n\n${NEXT_STEP_PREFIX}`);
	if (index < 0) {
		return null;
	}

	const value = content.slice(index + 2 + NEXT_STEP_PREFIX.length).trim();
	return value.length > 0 ? value : null;
}

function normalizeSuggestionText(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function looksLikePlanningRequest(content: string): boolean {
	return /(plan|strategy|approach|implement|build|fix|improve|optimi[sz]e|roadmap|prioriti[sz]e)/i.test(content);
}

function looksLikeComparisonRequest(content: string): boolean {
	return /(vs\.?|versus|tradeoff|trade-off|compare|comparison|better|best option|pros and cons)/i.test(content);
}

function looksLikeOpenEndedProblem(content: string): boolean {
	return /(how do we|what should we|how can we|ideas|brainstorm|stuck|not proactive|improve this|make it better)/i.test(content);
}

function buildAnalyticsNextStep(userContent: string, reply: string): string {
	if (/\b(metadata|dimension|metric)\b/i.test(userContent)) {
		return "if you want, I can turn this into an exact /analytics report or explore query using the dimensions and metrics that matter here.";
	}

	if (/\b(realtime|funnel|pivot|report|explore)\b/i.test(userContent)) {
		return "if you want, I can compare this against another date range or narrow it to a specific event, page, source, or segment.";
	}

	if (/outputFiles=|latest-summary\.md|latest-report\.json|latest-response\.json/i.test(reply)) {
		return "if you want, I can inspect the generated analytics artifacts and pull out the 2-3 biggest takeaways.";
	}

	return "if you want, I can narrow this to a specific funnel, event, page, traffic source, or date-range comparison.";
}