import { createSign } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { PluginCommand, PluginCommandContext, PluginCommandResult, PluginContract, PluginRouteRequest } from "../../../plugin-contract";
import { generateText, resolveAiTextModel } from "../../../ai/text-router";

const ANALYTICS_COMMAND_ALIASES = ["analytics", "a"];

const ANALYTICS_REQUIRED_ENV = [
	"GOOGLE_ANALYTICS_PROPERTY_ID",
	"GOOGLE_SERVICE_ACCOUNT_EMAIL",
	"GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
];

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GOOGLE_ANALYTICS_DATA_API_BETA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GOOGLE_ANALYTICS_DATA_API_ALPHA_BASE = "https://analyticsdata.googleapis.com/v1alpha";
const GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const GOOGLE_ANALYTICS_ADMIN_API_ALPHA_BASE = "https://analyticsadmin.googleapis.com/v1alpha";
const EXTERNAL_ENDPOINTS_DIRECTORY_NAME = "endpoints";
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 90;
const MAX_METADATA_PREVIEW_ITEMS = 25;
const MAX_ADMIN_PREVIEW_ITEMS = 20;

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

interface JsonObject {
	[key: string]: JsonValue;
}

type AnalyticsOperationKind = "help" | "legacy-report" | "comprehensive" | "metadata" | "admin" | "report" | "pivot" | "funnel" | "realtime" | "preset" | "explore";

interface AnalyticsDateRange {
	label: string;
	startDate: string;
	endDate: string;
}

interface GoogleTokenResponse {
	access_token: string;
	expires_in: number;
	token_type: string;
}

interface GoogleAnalyticsMetricHeader {
	name: string;
	type?: string;
}

interface GoogleAnalyticsDimensionHeader {
	name: string;
}

interface GoogleAnalyticsValue {
	value: string;
}

interface GoogleAnalyticsRow {
	dimensionValues?: GoogleAnalyticsValue[];
	metricValues?: GoogleAnalyticsValue[];
}

interface GoogleAnalyticsReportResponse {
	dimensionHeaders?: GoogleAnalyticsDimensionHeader[];
	metricHeaders?: GoogleAnalyticsMetricHeader[];
	rows?: GoogleAnalyticsRow[];
	totals?: GoogleAnalyticsRow[];
	rowCount?: number;
	metadata?: Record<string, unknown>;
	[property: string]: unknown;
}

interface GoogleAnalyticsMetadataItem {
	apiName?: string;
	uiName?: string;
	description?: string;
	customDefinition?: boolean;
	deprecatedApiNames?: string[];
	type?: string;
	expression?: string;
	category?: string;
	blockedReasons?: string[];
	[property: string]: unknown;
}

interface GoogleAnalyticsMetadataResponse {
	dimensions?: GoogleAnalyticsMetadataItem[];
	metrics?: GoogleAnalyticsMetadataItem[];
	[property: string]: unknown;
}

interface GoogleAnalyticsFunnelResponse {
	funnelTable?: GoogleAnalyticsReportResponse;
	funnelVisualization?: GoogleAnalyticsReportResponse;
	propertyQuota?: Record<string, unknown>;
	[property: string]: unknown;
}

interface AnalyticsOperationRequest {
	kind: AnalyticsOperationKind;
	dateRange?: AnalyticsDateRange;
	searchQuery?: string;
	adminResource?: string;
	payload?: JsonObject;
	presetName?: string;
	exploreName?: string;
}

interface AnalyticsExecutionResult {
	reply: string;
	requestPayload: JsonObject;
	responsePayload: JsonObject;
	summaryMarkdown: string;
	legacyReportArtifact?: JsonObject;
	externalResults?: ExternalEndpointExecutionResult[];
}

interface ExternalEndpointDefinition {
	url: string;
	apiKeyEnv: string;
	name?: string;
	description?: string;
	method?: string;
	enabled?: boolean;
	headers?: JsonObject;
	query?: JsonObject;
	body?: JsonValue;
	summaryFields?: string[];
	aiParameters?: ExternalEndpointAiParameters;
}

interface ExternalEndpointAiParameters {
	prompt?: string;
	fields: Record<string, ExternalEndpointAiFieldSchema>;
}

type ExternalEndpointAiFieldResolutionMode = "prefer-deterministic" | "deterministic-only" | "ai-only";

interface ExternalEndpointAiFieldSchema {
	type: "enum";
	options: string[];
	description?: string;
	resolutionMode?: ExternalEndpointAiFieldResolutionMode;
	analyticsRangeMapping?: ExternalEndpointAnalyticsRangeMapping;
}

interface ExternalEndpointAnalyticsRangeMapping {
	anchor?: "any" | "today";
	exactDayOptions?: {
		today?: string;
		yesterday?: string;
	};
	spanDayOptions?: Record<string, string>;
}

interface ExternalEndpointExecutionResult {
	endpointId: string;
	displayName: string;
	description?: string;
	method: string;
	url: string;
	apiKeyEnv: string;
	success: boolean;
	statusCode?: number;
	contentType?: string;
	summaryText: string;
	requestPayload: JsonObject;
	responsePayload: JsonObject;
}

interface ExternalEndpointAiResolutionResult {
	values: JsonObject;
	debug: JsonObject;
}

interface ParsedExternalEndpointAiResponse {
	fields: JsonObject;
	debug: JsonObject;
}

export interface AnalyticsNaturalLanguageIntent {
	args: string;
	subject: string;
	reason: string;
	confidence?: "low" | "medium" | "high";
	matchedBy?: "model" | "heuristic";
	preset?: string;
	dateArgs?: string | null;
}

interface AdminResourceConfig {
	apiBase: string;
	path: (propertyId: string) => string;
	responseKey: string;
	description: string;
}

interface PresetReportDefinition {
	label: string;
	description: string;
	request: JsonObject;
}

const PRESET_REPORT_CONFIG: Record<string, PresetReportDefinition> = {
	overview: {
		label: "Overview",
		description: "High-level summary: users, sessions, top events, top pages, and traffic sources.",
		request: {
			dimensions: [{ name: "date" }],
			metrics: [
				{ name: "activeUsers" },
				{ name: "newUsers" },
				{ name: "sessions" },
				{ name: "screenPageViews" },
				{ name: "engagementRate" },
				{ name: "bounceRate" },
				{ name: "averageSessionDuration" },
				{ name: "eventCount" },
			],
			orderBys: [{ dimension: { dimensionName: "date", orderType: "ALPHANUMERIC" } }],
			metricAggregations: ["TOTAL"],
			limit: "90",
		},
	},
	events: {
		label: "Events",
		description: "All events ranked by count, with unique user counts.",
		request: {
			dimensions: [{ name: "eventName" }],
			metrics: [
				{ name: "eventCount" },
				{ name: "totalUsers" },
				{ name: "eventCountPerUser" },
			],
			orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "50",
		},
	},
	pages: {
		label: "Pages",
		description: "Top pages by views, including engagement and average time.",
		request: {
			dimensions: [{ name: "pagePath" }],
			metrics: [
				{ name: "screenPageViews" },
				{ name: "activeUsers" },
				{ name: "engagementRate" },
				{ name: "averageSessionDuration" },
			],
			orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "30",
		},
	},
	landing: {
		label: "Landing Pages",
		description: "Top entry pages where sessions begin.",
		request: {
			dimensions: [{ name: "landingPagePlusQueryString" }],
			metrics: [
				{ name: "sessions" },
				{ name: "activeUsers" },
				{ name: "bounceRate" },
				{ name: "averageSessionDuration" },
			],
			orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "30",
		},
	},
	sources: {
		label: "Traffic Sources",
		description: "Where traffic comes from: source, medium, and campaign.",
		request: {
			dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
			metrics: [
				{ name: "sessions" },
				{ name: "activeUsers" },
				{ name: "engagementRate" },
				{ name: "conversions" },
			],
			orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "30",
		},
	},
	devices: {
		label: "Devices",
		description: "Device category and browser breakdown.",
		request: {
			dimensions: [{ name: "deviceCategory" }, { name: "browser" }],
			metrics: [
				{ name: "activeUsers" },
				{ name: "sessions" },
				{ name: "engagementRate" },
			],
			orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "25",
		},
	},
	geo: {
		label: "Geography",
		description: "Users by country and city.",
		request: {
			dimensions: [{ name: "country" }, { name: "city" }],
			metrics: [
				{ name: "activeUsers" },
				{ name: "sessions" },
				{ name: "engagementRate" },
			],
			orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "30",
		},
	},
	cohort: {
		label: "Cohort Retention",
		description: "Weekly cohort retention analysis — how many users come back after their first visit (Explore-style).",
		request: {},
	},
	journeys: {
		label: "User Journeys",
		description: "Landing page → second page sequences to approximate path exploration.",
		request: {
			dimensions: [
				{ name: "landingPagePlusQueryString" },
				{ name: "pagePath" },
			],
			metrics: [
				{ name: "sessions" },
				{ name: "activeUsers" },
				{ name: "engagementRate" },
			],
			orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
			metricAggregations: ["TOTAL"],
			limit: "40",
		},
	},
	engagement: {
		label: "Engagement Deep-Dive",
		description: "Session engagement breakdown: engaged sessions, duration, events per session, and key event rates.",
		request: {
			dimensions: [{ name: "date" }],
			metrics: [
				{ name: "engagedSessions" },
				{ name: "engagementRate" },
				{ name: "averageSessionDuration" },
				{ name: "screenPageViewsPerSession" },
				{ name: "eventCountPerUser" },
				{ name: "sessionsPerUser" },
				{ name: "bounceRate" },
				{ name: "dauPerMau" },
			],
			orderBys: [{ dimension: { dimensionName: "date", orderType: "ALPHANUMERIC" } }],
			metricAggregations: ["TOTAL"],
			limit: "90",
		},
	},
};

const ADMIN_RESOURCE_CONFIG: Record<string, AdminResourceConfig> = {
	"custom-dimensions": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE,
		path: (propertyId) => `/properties/${propertyId}/customDimensions`,
		responseKey: "customDimensions",
		description: "Registered event, user, and item scoped custom dimensions.",
	},
	"custom-metrics": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE,
		path: (propertyId) => `/properties/${propertyId}/customMetrics`,
		responseKey: "customMetrics",
		description: "Registered custom metrics.",
	},
	"key-events": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE,
		path: (propertyId) => `/properties/${propertyId}/keyEvents`,
		responseKey: "keyEvents",
		description: "Configured key events for the property.",
	},
	"data-streams": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE,
		path: (propertyId) => `/properties/${propertyId}/dataStreams`,
		responseKey: "dataStreams",
		description: "Web, iOS, and Android data streams.",
	},
	"google-ads-links": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE,
		path: (propertyId) => `/properties/${propertyId}/googleAdsLinks`,
		responseKey: "googleAdsLinks",
		description: "Linked Google Ads accounts.",
	},
	"firebase-links": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_BETA_BASE,
		path: (propertyId) => `/properties/${propertyId}/firebaseLinks`,
		responseKey: "firebaseLinks",
		description: "Linked Firebase projects.",
	},
	"audiences": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_ALPHA_BASE,
		path: (propertyId) => `/properties/${propertyId}/audiences`,
		responseKey: "audiences",
		description: "Audience definitions available through the Admin API alpha surface.",
	},
	"expanded-data-sets": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_ALPHA_BASE,
		path: (propertyId) => `/properties/${propertyId}/expandedDataSets`,
		responseKey: "expandedDataSets",
		description: "Expanded data set definitions available for eligible properties.",
	},
	"search-ads-360-links": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_ALPHA_BASE,
		path: (propertyId) => `/properties/${propertyId}/searchAds360Links`,
		responseKey: "searchAds360Links",
		description: "Linked Search Ads 360 accounts.",
	},
	"dv360-links": {
		apiBase: GOOGLE_ANALYTICS_ADMIN_API_ALPHA_BASE,
		path: (propertyId) => `/properties/${propertyId}/displayVideo360AdvertiserLinks`,
		responseKey: "displayVideo360AdvertiserLinks",
		description: "Linked Display & Video 360 advertisers.",
	},
};

export const analyticsCommand: PluginCommand = {
	name: "analytics",
	description: "Fetch GA4 metadata, reports, pivots, funnels, realtime data, and admin resources for the growth-genius plugin.",
	requiredEnv: ANALYTICS_REQUIRED_ENV,
	match: (input: PluginRouteRequest) => {
		const trimmed = input.content.trim();
		const lower = trimmed.toLowerCase();
		for (const alias of ANALYTICS_COMMAND_ALIASES) {
			const slash = `/${alias}`;
			if (lower === slash) {
				return { subject: "analytics", args: "", reason: "slash-command-alias-match" };
			}
			if (lower.startsWith(`${slash} `)) {
				return { subject: "analytics", args: trimmed.slice(slash.length).trim(), reason: "slash-command-alias-match" };
			}
		}
		return null;
	},
	handle: async (input) => {
		return executeAnalyticsInvocation(input, {
			args: input.args,
			requestSource: "/analytics",
		});
	},
};

export async function executeAnalyticsInvocation(
	input: PluginCommandContext,
	options: {
		args: string;
		requestSource: string;
		originalPrompt?: string;
		nlIntent?: AnalyticsNaturalLanguageIntent;
	},
): Promise<PluginCommandResult> {
	const analyticsOutputDir = path.join(input.outputDir, "analytics");
	await mkdir(analyticsOutputDir, { recursive: true });

	const appDataDir = path.resolve(path.dirname(path.resolve(process.cwd(), input.plugin.envFilePath)), "data");
	const propertyId = process.env.GOOGLE_ANALYTICS_PROPERTY_ID!.trim();
	const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim();
	const serviceAccountPrivateKey = normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!);
	const exploreDir = path.join(appDataDir, "explore");
	const externalEndpointsDir = path.join(appDataDir, EXTERNAL_ENDPOINTS_DIRECTORY_NAME);
	const operation = parseAnalyticsOperation(options.args);

	const accessToken = await getGoogleAccessToken({
		serviceAccountEmail,
		serviceAccountPrivateKey,
	});

	const externalResults = shouldExecuteExternalEndpoints({
		operation,
		requestSource: options.requestSource,
	})
		? await executeConfiguredExternalEndpoints({
			endpointsDir: externalEndpointsDir,
			operation,
			propertyId,
			promptText: options.originalPrompt?.trim() || input.content.trim(),
			plugin: input.plugin,
		  })
		: [];

	let execution = await executeAnalyticsOperation({
		propertyId,
		accessToken,
		operation,
		plugin: input.plugin,
		exploreDir,
		externalResults,
	});

	if (externalResults.length > 0) {
		execution = mergeExternalEndpointResults(execution, externalResults);
	}

	const requestedAt = new Date().toISOString();
	const requestArtifactPath = path.join(analyticsOutputDir, "latest-request.json");
	const responseArtifactPath = path.join(analyticsOutputDir, "latest-response.json");
	const summaryArtifactPath = path.join(analyticsOutputDir, "latest-summary.md");
	const legacyReportArtifactPath = path.join(analyticsOutputDir, "latest-report.json");

	await writeFile(
		requestArtifactPath,
		JSON.stringify(
			{
				pluginId: input.plugin.id,
				command: options.requestSource,
				requestedAt,
				requestedBy: {
					userId: input.message.author.id,
					username: input.message.author.username,
				},
				args: options.args,
				originalPrompt: options.originalPrompt ?? null,
				nlInterpretation: options.nlIntent
					? {
						matchedBy: options.nlIntent.matchedBy ?? null,
						confidence: options.nlIntent.confidence ?? null,
						subject: options.nlIntent.subject,
						preset: options.nlIntent.preset ?? null,
						dateArgs: options.nlIntent.dateArgs ?? null,
						args: options.nlIntent.args,
						reason: options.nlIntent.reason,
					}
					: null,
				pluginRootDir: input.plugin.rootDir,
				outputDir: input.plugin.outputDir,
				propertyId,
				operation: execution.requestPayload,
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(responseArtifactPath, JSON.stringify(execution.responsePayload, null, 2), "utf8");
	await writeFile(summaryArtifactPath, execution.summaryMarkdown, "utf8");

	const outputFiles = [
		path.relative(process.cwd(), requestArtifactPath),
		path.relative(process.cwd(), responseArtifactPath),
		path.relative(process.cwd(), summaryArtifactPath),
	];

	if (execution.legacyReportArtifact) {
		await writeFile(legacyReportArtifactPath, JSON.stringify(execution.legacyReportArtifact, null, 2), "utf8");
		outputFiles.splice(2, 0, path.relative(process.cwd(), legacyReportArtifactPath));
	}

	const reply = options.originalPrompt?.trim() && options.requestSource === "analytics-natural-language"
		? await generateNaturalLanguageAnalyticsReply({
			originalPrompt: options.originalPrompt,
			analyticsArgs: options.args,
			summaryMarkdown: execution.summaryMarkdown,
			fallbackReply: execution.reply,
			plugin: input.plugin,
		  })
		: execution.reply;
	const finalReply = execution.externalResults?.length
		? appendExternalEndpointResultsToReply(reply, execution.externalResults)
		: reply;

	return {
		reply: finalReply,
		outputFiles,
		diagnostics: options.nlIntent ? buildAnalyticsInterpretationDiagnostics(options.nlIntent) : undefined,
	};
}

export function formatAnalyticsCommandResult(input: {
	pluginId: string;
	commandName: string;
	outputDir: string;
	result: PluginCommandResult | string;
}): string {
	if (typeof input.result === "string") {
		return input.result;
	}

	const outputFiles = input.result.outputFiles?.filter((value) => value.trim().length > 0) ?? [];
	const diagnostics = input.result.diagnostics?.filter((value) => value.trim().length > 0) ?? [];
	if (outputFiles.length === 0 && diagnostics.length === 0) {
		return input.result.reply;
	}

	return [
		input.result.reply,
		...diagnostics,
		`command=/${input.commandName}`,
		`plugin=${input.pluginId}`,
		`outputDir=${path.relative(process.cwd(), input.outputDir) || input.outputDir}`,
		`outputFiles=${outputFiles.join(",")}`,
	].join("\n");
}

export function matchNaturalLanguageAnalyticsRequest(content: string): AnalyticsNaturalLanguageIntent | null {
	const normalized = content.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	if (!looksLikeAnalyticsNaturalLanguageRequest(normalized)) {
		return null;
	}

	const preset = inferAnalyticsPreset(normalized);
	const dateRange = inferAnalyticsDateRangeArgs(normalized);
	const args = dateRange ? `${preset} ${dateRange}` : preset;

	return {
		args,
		subject: `analytics-${preset}`,
		reason: "analytics-natural-language-match",
		confidence: "medium",
		matchedBy: "heuristic",
		preset,
		dateArgs: dateRange,
	};
}

export async function matchNaturalLanguageAnalyticsRequestWithModel(
	content: string,
	plugin?: PluginContract,
): Promise<AnalyticsNaturalLanguageIntent | null> {
	const normalized = content.trim();
	if (!normalized) {
		return null;
	}

	if (/^\/analytics\b/i.test(normalized)) {
		return null;
	}

	const modelResult = await translateNaturalLanguageAnalyticsIntent(normalized, plugin);
	if (modelResult) {
		return modelResult;
	}

	return matchNaturalLanguageAnalyticsRequest(content);
}

function parseAnalyticsOperation(args: string): AnalyticsOperationRequest {
	const trimmed = args.trim();
	if (!trimmed) {
		return {
			kind: "comprehensive",
			dateRange: buildTrailingDayRange(DEFAULT_LOOKBACK_DAYS),
		};
	}

	if (looksLikeLegacyDateRange(trimmed)) {
		return {
			kind: "legacy-report",
			dateRange: parseAnalyticsDateRange(trimmed),
		};
	}

	const [operationToken, ...restTokens] = trimmed.split(/\s+/);
	const operationName = operationToken.toLowerCase();
	const remainder = trimmed.slice(operationToken.length).trim();

	switch (operationName) {
		case "help":
			return { kind: "help" };
		case "metadata":
			return {
				kind: "metadata",
				searchQuery: remainder || undefined,
			};
		case "admin": {
			const adminResource = restTokens[0]?.toLowerCase();
			if (!adminResource) {
				throw new Error(`Missing admin resource. Supported resources: ${Object.keys(ADMIN_RESOURCE_CONFIG).join(", ")}.`);
			}

			if (!(adminResource in ADMIN_RESOURCE_CONFIG)) {
				throw new Error(`Unsupported admin resource '${adminResource}'. Supported resources: ${Object.keys(ADMIN_RESOURCE_CONFIG).join(", ")}.`);
			}

			return {
				kind: "admin",
				adminResource,
				searchQuery: restTokens.slice(1).join(" ").trim() || undefined,
			};
		}
		case "report":
		case "pivot":
		case "funnel":
		case "realtime":
			return {
				kind: operationName,
				payload: parseJsonPayload(operationName, remainder),
			};
		case "explore": {
			const exploreName = restTokens[0];
			if (!exploreName) {
				throw new Error("Missing explore name. Usage: /analytics explore <name> [date]. Files are loaded from apps/growth-genius/data/explore/<name>.json.");
			}
			const exploreDateArgs = restTokens.slice(1).join(" ").trim();
			return {
				kind: "explore",
				exploreName,
				dateRange: exploreDateArgs ? parseAnalyticsDateRange(exploreDateArgs) : buildTrailingDayRange(DEFAULT_LOOKBACK_DAYS),
			};
		}
		default: {
			if (operationName in PRESET_REPORT_CONFIG) {
				return {
					kind: "preset",
					presetName: operationName,
					dateRange: remainder ? parseAnalyticsDateRange(remainder) : buildTrailingDayRange(DEFAULT_LOOKBACK_DAYS),
				};
			}
			throw new Error(buildHelpText());
		}
	}
}

function looksLikeLegacyDateRange(value: string): boolean {
	return /^(?:last:?)?\d{1,3}d(?:ays)?$/i.test(value) || /^\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseJsonPayload(kind: string, raw: string): JsonObject {
	if (!raw) {
		throw new Error(`Missing JSON payload for /analytics ${kind}. ${buildHelpText()}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON payload for /analytics ${kind}: ${formatErrorMessage(error)}`);
	}

	if (!isJsonObject(parsed)) {
		throw new Error(`Expected a JSON object for /analytics ${kind}.`);
	}

	return parsed;
}

async function executeAnalyticsOperation(input: {
	propertyId: string;
	accessToken: string;
	operation: AnalyticsOperationRequest;
	plugin: PluginContract;
	exploreDir: string;
	externalResults: ExternalEndpointExecutionResult[];
}): Promise<AnalyticsExecutionResult> {
	switch (input.operation.kind) {
		case "help":
			return await buildHelpExecutionResult(input.exploreDir);
		case "comprehensive":
			return await executeComprehensiveReport(input.propertyId, input.accessToken, input.operation.dateRange!, input.exploreDir, input.plugin, input.externalResults);
		case "legacy-report":
			return await executeLegacyReport(input.propertyId, input.accessToken, input.operation.dateRange!);
		case "metadata":
			return await executeMetadataRequest(input.propertyId, input.accessToken, input.operation.searchQuery);
		case "admin":
			return await executeAdminRequest(input.propertyId, input.accessToken, input.operation.adminResource!, input.operation.searchQuery);
		case "report":
			return await executeReportRequest(input.propertyId, input.accessToken, input.operation.payload!);
		case "pivot":
			return await executePivotRequest(input.propertyId, input.accessToken, input.operation.payload!);
		case "funnel":
			return await executeFunnelRequest(input.propertyId, input.accessToken, input.operation.payload!);
		case "realtime":
			return await executeRealtimeRequest(input.propertyId, input.accessToken, input.operation.payload!);
		case "preset":
			return await executePresetRequest(input.propertyId, input.accessToken, input.operation.presetName!, input.operation.dateRange!);
		case "explore":
			return await executeExploreRequest(input.propertyId, input.accessToken, input.operation.exploreName!, input.operation.dateRange!, input.exploreDir);
	}
}

async function buildHelpExecutionResult(exploreDir: string): Promise<AnalyticsExecutionResult> {
	const presetList = Object.entries(PRESET_REPORT_CONFIG)
		.map(([name, config]) => `- \`/analytics ${name}\` — ${config.description}`)
		.join("\n");

	const savedExplores = await listSavedExplores(exploreDir);
	const exploreSection = savedExplores.length > 0
		? [
			"## Custom explores (saved reports)",
			"",
			...savedExplores.map((name) => `- \`/analytics explore ${name}\``),
			"",
			`Files in \`${path.relative(process.cwd(), exploreDir)}/\`. Add any \`.json\` file with a GA4 report body.`,
			"",
		]
		: [
			"## Custom explores (saved reports)",
			"",
			`No saved explores found. Add \`.json\` files in \`${path.relative(process.cwd(), exploreDir)}/\`.`,
			"",
		];

	const summaryMarkdown = [
		"# Analytics Command Help",
		"",
		"## Quick presets (proactive reports)",
		"",
		presetList,
		"",
		"All presets default to the last 7 days. Add a date range: `/analytics events 30d` or `/analytics pages 2026-03-01 2026-03-21`.",
		"",
		...exploreSection,
		"## Preserved default report",
		"",
		"- `/analytics` — comprehensive report: overview + all explores + AI summary (7d default)",
		"- `/analytics 30d` — legacy date-only report",
		"- `/analytics 2026-03-01 2026-03-21` — legacy custom-range report",
		"",
		"## Discovery",
		"",
		"- `/analytics metadata`",
		"- `/analytics metadata event`",
		`- "/analytics admin <resource>" where <resource> is one of: ${Object.keys(ADMIN_RESOURCE_CONFIG).join(", ")}`,
		"",
		"## Flexible GA4 queries",
		"",
		"- `/analytics report {\"days\":30,\"dimensions\":[\"eventName\"],\"metrics\":[\"eventCount\"],\"limit\":25}`",
		"- `/analytics pivot {\"days\":30,\"dimensions\":[\"deviceCategory\",\"eventName\"],\"metrics\":[\"eventCount\"],\"pivots\":[{\"fieldNames\":[\"deviceCategory\"],\"limit\":5},{\"fieldNames\":[\"eventName\"],\"limit\":10}]}`",
		"- `/analytics funnel {\"days\":30,\"funnel\":{\"steps\":[{\"name\":\"Landing\",\"filterExpression\":{\"funnelEventFilter\":{\"eventName\":\"page_view\"}}},{\"name\":\"Purchase\",\"filterExpression\":{\"funnelEventFilter\":{\"eventName\":\"purchase\"}}}]}}`",
		"- `/analytics realtime {\"dimensions\":[\"eventName\"],\"metrics\":[\"eventCount\"],\"limit\":10}`",
		"",
		"## External endpoints",
		"",
		"- Explicit slash-command report-style runs (`/analytics`, `/a`, presets, explicit date ranges, and `/analytics explore <name>`) also call any JSON endpoint definitions found in `apps/growth-genius/data/endpoints/`.",
		"- Each endpoint request sends `x-api-key` using the env var named by the endpoint definition's `apiKeyEnv` field.",
		"- Natural-language analytics routing stays GA-only until you invoke `/analytics` or `/a` directly.",
		"- `metadata`, `admin`, `report`, `pivot`, `funnel`, and `realtime` stay GA-only.",
		"",
		"## Notes",
		"",
		"- `metadata` is the way to discover property-specific metrics, dimensions, custom definitions, and key-event-derived metrics.",
		"- `report`, `pivot`, `funnel`, and `realtime` accept native GA4 API request bodies with a few conveniences: `days`, `startDate`, and `endDate`.",
		"- GA4 exposes funnel/pivot style exploration queries, but it does not expose saved Explore boards or explorations as listable API resources.",
	].join("\n");

	return {
		reply: [
			"/analytics help",
			`presets=${Object.keys(PRESET_REPORT_CONFIG).join(",")}`,
			`explores=${savedExplores.join(",") || "none"}`,
			"legacyReport=true",
			"metadata=true",
			`adminResources=${Object.keys(ADMIN_RESOURCE_CONFIG).join(",")}`,
			"customReports=true",
			"savedExploreBoardsApi=false",
		].join("\n"),
		requestPayload: { kind: "help" },
		responsePayload: { help: summaryMarkdown },
		summaryMarkdown,
	};
}

async function executeComprehensiveReport(
	propertyId: string,
	accessToken: string,
	dateRange: AnalyticsDateRange,
	exploreDir: string,
	plugin: PluginContract,
	externalResults: ExternalEndpointExecutionResult[],
): Promise<AnalyticsExecutionResult> {
	const dateRanges = [{ startDate: dateRange.startDate, endDate: dateRange.endDate }];

	// Run overview preset reports in parallel
	const [mainReport, eventsReport, pagesReport, sourcesReport, engagementReport] = await Promise.all([
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.overview.request), dateRanges },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.events.request), dateRanges, limit: "25" },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.pages.request), dateRanges, limit: "15" },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.sources.request), dateRanges, limit: "15" },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.engagement.request), dateRanges },
		}),
	]);

	// Run all saved explores in parallel
	const exploreNames = await listSavedExplores(exploreDir);
	const exploreResults: Array<{ name: string; report: GoogleAnalyticsReportResponse; definition: JsonObject }> = [];
	if (exploreNames.length > 0) {
		const explorePromises = exploreNames.map(async (name) => {
			const definition = await loadExploreDefinition(exploreDir, name);
			const apiKind = typeof definition.kind === "string" ? definition.kind : "report";
			const requestBody: JsonObject = { ...cloneJsonObject(definition) };
			delete requestBody.kind;
			delete requestBody.name;
			delete requestBody.description;
			if (!Array.isArray(requestBody.dateRanges)) {
				requestBody.dateRanges = dateRanges as JsonValue;
			}

			let apiBase: string;
			let apiPath: string;
			switch (apiKind) {
				case "pivot":
					apiBase = GOOGLE_ANALYTICS_DATA_API_BETA_BASE;
					apiPath = `/properties/${propertyId}:runPivotReport`;
					break;
				case "funnel":
					apiBase = GOOGLE_ANALYTICS_DATA_API_ALPHA_BASE;
					apiPath = `/properties/${propertyId}:runFunnelReport`;
					break;
				case "realtime":
					apiBase = GOOGLE_ANALYTICS_DATA_API_BETA_BASE;
					apiPath = `/properties/${propertyId}:runRealtimeReport`;
					break;
				default:
					apiBase = GOOGLE_ANALYTICS_DATA_API_BETA_BASE;
					apiPath = `/properties/${propertyId}:runReport`;
					break;
			}

			const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
				apiBase,
				path: apiPath,
				accessToken,
				body: requestBody,
			});

			return { name, report, definition };
		});
		exploreResults.push(...await Promise.all(explorePromises));
	}

	// Build data summary sections for AI
	const mainSummary = buildReportSummary(mainReport, dateRange, propertyId, "Overview");
	const dataSections: string[] = [
		mainSummary.markdown,
		"",
		"## Top Events",
		"",
		...buildTopRowsPreview(eventsReport, 25),
		"",
		"## Top Pages",
		"",
		...buildTopRowsPreview(pagesReport, 15),
		"",
		"## Top Traffic Sources",
		"",
		...buildTopRowsPreview(sourcesReport, 15),
		"",
		"## Engagement Trends",
		"",
		...buildTopRowsPreview(engagementReport, 14),
	];

	for (const explore of exploreResults) {
		const displayName = typeof explore.definition.name === "string" ? explore.definition.name : explore.name;
		const description = typeof explore.definition.description === "string" ? ` — ${explore.definition.description}` : "";
		dataSections.push(
			"",
			`## Explore: ${displayName}${description}`,
			"",
			...buildTopRowsPreview(explore.report, 20),
		);
	}

	for (const extResult of externalResults) {
		if (!extResult.success) {
			continue;
		}
		const extDescription = extResult.description ? ` — ${extResult.description}` : "";
		dataSections.push(
			"",
			`## External Endpoint: ${extResult.displayName}${extDescription}`,
			"",
			...buildExternalEndpointDataPreview(extResult.responsePayload),
		);
	}

	const analyticsDataMarkdown = dataSections.join("\n");

	// Send to OpenAI for summary and recommendations
	const aiSummary = await generateComprehensiveAISummary(analyticsDataMarkdown, dateRange, plugin);

	const summaryMarkdown = [
		`# Comprehensive Analytics Report`,
		"",
		`- property: ${propertyId}`,
		`- range: ${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
		`- presets: overview, events, pages, sources, engagement`,
		`- explores: ${exploreNames.length > 0 ? exploreNames.join(", ") : "none"}`,
		"",
		"---",
		"",
		aiSummary,
		"",
		"---",
		"",
		"# Raw Data",
		"",
		analyticsDataMarkdown,
	].join("\n");

	return {
		reply: aiSummary,
		requestPayload: {
			kind: "comprehensive",
			dateRange: serializeDateRange(dateRange),
			presets: ["overview", "events", "pages", "sources", "engagement"],
			explores: exploreNames,
		},
		responsePayload: {
			mainReport: mainReport as JsonObject,
			eventsReport: eventsReport as JsonObject,
			pagesReport: pagesReport as JsonObject,
			sourcesReport: sourcesReport as JsonObject,
			engagementReport: engagementReport as JsonObject,
			explores: Object.fromEntries(exploreResults.map((e) => [e.name, e.report as JsonObject])),
		},
		summaryMarkdown,
		legacyReportArtifact: mainReport as JsonObject,
	};
}

async function generateComprehensiveAISummary(
	analyticsData: string,
	dateRange: AnalyticsDateRange,
	plugin: PluginContract,
): Promise<string> {
	const model = getAnalyticsSummaryModel(plugin);

	const response = await generateText({
		task: "analytics-summary",
		model,
		plugin,
		input: [
			{
				role: "system",
				content: [{
					type: "input_text",
					text: [
						"You are a senior growth analyst. The user will provide a reporting dataset that includes Google Analytics 4 data and may include supplemental external endpoint results for the same period.",
						"Your job is to produce a concise, actionable report in Markdown with:",
						"1. **Executive Summary** — 2-3 sentence high-level takeaway.",
						"2. **Key Metrics** — highlight the most important numbers (users, sessions, engagement, bounce rate, top events).",
						"3. **Trends & Patterns** — what changed, what stands out, any anomalies.",
						"4. **Top Content & Sources** — which pages and traffic sources are performing well or poorly.",
						"5. **Custom Explore Insights** — insights from any custom explore data included.",
						"6. **External Endpoint Insights** — incorporate any supplemental endpoint results when they add context or explain the GA movement.",
						"7. **Recommendations** — 3-5 concrete, prioritized actions to improve growth.",
						"",
						"Be specific with numbers. Reference actual data points. When external data is present, synthesize it with the GA trends instead of treating it as a separate appendix. Keep it concise but thorough.",
						"Format for Discord (Markdown). Do not exceed 1800 characters in total.",
					].join("\n"),
				}],
			},
			{
				role: "user",
				content: [{
					type: "input_text",
					text: `Here is the analytics data (${dateRange.label}, ${dateRange.startDate} to ${dateRange.endDate}):\n\n${analyticsData}`,
				}],
			},
		] as ResponseInputItem[],
	});

	const text = response.text;
	if (!text) {
		return "*AI summary unavailable — the configured AI provider returned an empty response.*";
	}

	return text;
}

async function executeLegacyReport(propertyId: string, accessToken: string, dateRange: AnalyticsDateRange): Promise<AnalyticsExecutionResult> {
	const requestPayload = {
		kind: "legacy-report",
		dateRange: serializeDateRange(dateRange),
		request: {
			dateRanges: [
				{
					startDate: dateRange.startDate,
					endDate: dateRange.endDate,
				},
			],
			dimensions: [{ name: "date" }],
			metrics: [
				{ name: "activeUsers" },
				{ name: "newUsers" },
				{ name: "sessions" },
				{ name: "screenPageViews" },
				{ name: "engagementRate" },
			],
			orderBys: [
				{
					dimension: { dimensionName: "date", orderType: "ALPHANUMERIC" },
				},
			],
			metricAggregations: ["TOTAL"],
			limit: String(MAX_LOOKBACK_DAYS),
		},
	} satisfies JsonObject;

	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}:runReport`,
		accessToken,
		body: requestPayload.request as JsonObject,
	});

	const summary = buildReportSummary(report, dateRange, propertyId, "Analytics Summary");
	return {
		reply: [
			`/analytics routed to legacy report for property ${propertyId}.`,
			`range=${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
			`activeUsers=${summary.totals.activeUsers ?? "0"}`,
			`newUsers=${summary.totals.newUsers ?? "0"}`,
			`sessions=${summary.totals.sessions ?? "0"}`,
			`screenPageViews=${summary.totals.screenPageViews ?? "0"}`,
			`engagementRate=${summary.totals.engagementRate ?? "0"}`,
			`rows=${summary.rowCount}`,
		].join("\n"),
		requestPayload,
		responsePayload: report as JsonObject,
		summaryMarkdown: summary.markdown,
		legacyReportArtifact: report as JsonObject,
	};
}

async function executeMetadataRequest(propertyId: string, accessToken: string, searchQuery?: string): Promise<AnalyticsExecutionResult> {
	const metadata = await runAnalyticsRequest<GoogleAnalyticsMetadataResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}/metadata`,
		accessToken,
		method: "GET",
	});

	const filteredMetadata = filterMetadata(metadata, searchQuery);
	const dimensions = filteredMetadata.dimensions ?? [];
	const metrics = filteredMetadata.metrics ?? [];
	const customDimensions = dimensions.filter((item) => item.customDefinition || item.apiName?.startsWith("custom")).length;
	const customMetrics = metrics.filter((item) => item.customDefinition || item.apiName?.startsWith("custom") || item.apiName?.startsWith("averageCustom") || item.apiName?.startsWith("countCustom")).length;
	const summaryMarkdown = [
		"# Analytics Metadata",
		"",
		`- property: ${propertyId}`,
		`- filter: ${searchQuery || "none"}`,
		`- dimensions: ${dimensions.length}`,
		`- metrics: ${metrics.length}`,
		`- customDimensions: ${customDimensions}`,
		`- customMetrics: ${customMetrics}`,
		"",
		"## Dimension Preview",
		"",
		...buildMetadataPreview(dimensions),
		"",
		"## Metric Preview",
		"",
		...buildMetadataPreview(metrics),
	].join("\n");

	return {
		reply: [
			`/analytics metadata for property ${propertyId}.`,
			`filter=${searchQuery || "none"}`,
			`dimensions=${dimensions.length}`,
			`metrics=${metrics.length}`,
			`customDimensions=${customDimensions}`,
			`customMetrics=${customMetrics}`,
		].join("\n"),
		requestPayload: {
			kind: "metadata",
			filter: searchQuery ?? null,
		},
		responsePayload: filteredMetadata as JsonObject,
		summaryMarkdown,
	};
}

async function executeAdminRequest(propertyId: string, accessToken: string, resource: string, searchQuery?: string): Promise<AnalyticsExecutionResult> {
	const resourceConfig = ADMIN_RESOURCE_CONFIG[resource];
	const response = await listAdminResources({
		propertyId,
		accessToken,
		resource,
		config: resourceConfig,
	});
	const filteredItems = filterAdminItems(response.items, searchQuery);
	const summaryMarkdown = [
		`# Analytics Admin: ${resource}`,
		"",
		`- property: ${propertyId}`,
		`- description: ${resourceConfig.description}`,
		`- filter: ${searchQuery || "none"}`,
		`- items: ${filteredItems.length}`,
		"",
		"## Preview",
		"",
		...buildAdminPreview(filteredItems),
	].join("\n");

	return {
		reply: [
			`/analytics admin ${resource} for property ${propertyId}.`,
			`filter=${searchQuery || "none"}`,
			`items=${filteredItems.length}`,
		].join("\n"),
		requestPayload: {
			kind: "admin",
			resource,
			filter: searchQuery ?? null,
		},
		responsePayload: {
			resource,
			description: resourceConfig.description,
			[resourceConfig.responseKey]: filteredItems,
		} as JsonObject,
		summaryMarkdown,
	};
}

async function executeReportRequest(propertyId: string, accessToken: string, payload: JsonObject): Promise<AnalyticsExecutionResult> {
	const normalizedRequest = normalizeReportRequest(payload);
	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}:runReport`,
		accessToken,
		body: normalizedRequest,
	});

	const dateRangeLabel = describeRequestDateRanges(normalizedRequest.dateRanges);
	const summary = buildReportSummary(report, dateRangeLabel, propertyId, "Analytics Report");
	return {
		reply: [
			`/analytics report for property ${propertyId}.`,
			`range=${dateRangeLabel}`,
			`dimensions=${(report.dimensionHeaders ?? []).map((item) => item.name).join(",") || "none"}`,
			`metrics=${(report.metricHeaders ?? []).map((item) => item.name).join(",") || "none"}`,
			`rows=${summary.rowCount}`,
		].join("\n"),
		requestPayload: {
			kind: "report",
			request: normalizedRequest,
		},
		responsePayload: report as JsonObject,
		summaryMarkdown: summary.markdown,
		legacyReportArtifact: report as JsonObject,
	};
}

async function executePivotRequest(propertyId: string, accessToken: string, payload: JsonObject): Promise<AnalyticsExecutionResult> {
	const normalizedRequest = normalizePivotRequest(payload);
	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}:runPivotReport`,
		accessToken,
		body: normalizedRequest,
	});

	const summaryMarkdown = buildGenericTabularSummary({
		title: "Analytics Pivot Report",
		propertyId,
		dateRangeLabel: describeRequestDateRanges(normalizedRequest.dateRanges),
		report,
	});

	return {
		reply: [
			`/analytics pivot for property ${propertyId}.`,
			`range=${describeRequestDateRanges(normalizedRequest.dateRanges)}`,
			`dimensions=${(report.dimensionHeaders ?? []).map((item) => item.name).join(",") || "none"}`,
			`metrics=${(report.metricHeaders ?? []).map((item) => item.name).join(",") || "none"}`,
			`rows=${report.rowCount ?? report.rows?.length ?? 0}`,
		].join("\n"),
		requestPayload: {
			kind: "pivot",
			request: normalizedRequest,
		},
		responsePayload: report as JsonObject,
		summaryMarkdown,
	};
}

async function executeRealtimeRequest(propertyId: string, accessToken: string, payload: JsonObject): Promise<AnalyticsExecutionResult> {
	const normalizedRequest = normalizeRealtimeRequest(payload);
	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}:runRealtimeReport`,
		accessToken,
		body: normalizedRequest,
	});

	const summaryMarkdown = buildGenericTabularSummary({
		title: "Analytics Realtime Report",
		propertyId,
		dateRangeLabel: "realtime",
		report,
	});

	return {
		reply: [
			`/analytics realtime for property ${propertyId}.`,
			`dimensions=${(report.dimensionHeaders ?? []).map((item) => item.name).join(",") || "none"}`,
			`metrics=${(report.metricHeaders ?? []).map((item) => item.name).join(",") || "none"}`,
			`rows=${report.rowCount ?? report.rows?.length ?? 0}`,
		].join("\n"),
		requestPayload: {
			kind: "realtime",
			request: normalizedRequest,
		},
		responsePayload: report as JsonObject,
		summaryMarkdown,
	};
}

async function executeFunnelRequest(propertyId: string, accessToken: string, payload: JsonObject): Promise<AnalyticsExecutionResult> {
	const normalizedRequest = normalizeFunnelRequest(payload);
	const report = await runAnalyticsRequest<GoogleAnalyticsFunnelResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_ALPHA_BASE,
		path: `/properties/${propertyId}:runFunnelReport`,
		accessToken,
		body: normalizedRequest,
	});

	const funnelTableRows = report.funnelTable?.rows?.length ?? 0;
	const funnelVisualizationRows = report.funnelVisualization?.rows?.length ?? 0;
	const summaryMarkdown = [
		"# Analytics Funnel Report",
		"",
		`- property: ${propertyId}`,
		`- range: ${describeRequestDateRanges(normalizedRequest.dateRanges)}`,
		`- funnelTableRows: ${funnelTableRows}`,
		`- funnelVisualizationRows: ${funnelVisualizationRows}`,
		"",
		"## Funnel Table Headers",
		"",
		...buildHeaderPreview(report.funnelTable),
		"",
		"## Funnel Visualization Headers",
		"",
		...buildHeaderPreview(report.funnelVisualization),
	].join("\n");

	return {
		reply: [
			`/analytics funnel for property ${propertyId}.`,
			`range=${describeRequestDateRanges(normalizedRequest.dateRanges)}`,
			`funnelTableRows=${funnelTableRows}`,
			`funnelVisualizationRows=${funnelVisualizationRows}`,
		].join("\n"),
		requestPayload: {
			kind: "funnel",
			request: normalizedRequest,
		},
		responsePayload: report as JsonObject,
		summaryMarkdown,
	};
}

async function executePresetRequest(
	propertyId: string,
	accessToken: string,
	presetName: string,
	dateRange: AnalyticsDateRange,
): Promise<AnalyticsExecutionResult> {
	const preset = PRESET_REPORT_CONFIG[presetName];
	const requestBody: JsonObject = {
		...cloneJsonObject(preset.request),
		dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
	};

	if (presetName === "overview") {
		return await executeOverviewPreset(propertyId, accessToken, dateRange);
	}

	if (presetName === "cohort") {
		return await executeCohortPreset(propertyId, accessToken, dateRange);
	}

	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}:runReport`,
		accessToken,
		body: requestBody,
	});

	const summary = buildReportSummary(report, dateRange, propertyId, `Analytics Preset: ${preset.label}`);
	const rowCount = report.rowCount ?? report.rows?.length ?? 0;
	const topEntries = buildTopRowsPreview(report, 10);

	const summaryMarkdown = [
		summary.markdown,
		"",
		`## Top ${preset.label}`,
		"",
		...topEntries,
	].join("\n");

	return {
		reply: [
			`/analytics ${presetName} for property ${propertyId}.`,
			`preset=${preset.label}`,
			`range=${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
			`rows=${rowCount}`,
			"",
			`## Top ${preset.label}`,
			"",
			...topEntries,
		].join("\n"),
		requestPayload: { kind: "preset", preset: presetName, request: requestBody },
		responsePayload: report as JsonObject,
		summaryMarkdown,
		legacyReportArtifact: report as JsonObject,
	};
}

async function executeOverviewPreset(
	propertyId: string,
	accessToken: string,
	dateRange: AnalyticsDateRange,
): Promise<AnalyticsExecutionResult> {
	const dateRanges = [{ startDate: dateRange.startDate, endDate: dateRange.endDate }];

	const [mainReport, eventsReport, pagesReport, sourcesReport] = await Promise.all([
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.overview.request), dateRanges },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.events.request), dateRanges, limit: "15" },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.pages.request), dateRanges, limit: "10" },
		}),
		runAnalyticsRequest<GoogleAnalyticsReportResponse>({
			apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
			path: `/properties/${propertyId}:runReport`,
			accessToken,
			body: { ...cloneJsonObject(PRESET_REPORT_CONFIG.sources.request), dateRanges, limit: "10" },
		}),
	]);

	const mainSummary = buildReportSummary(mainReport, dateRange, propertyId, "Analytics Overview");

	const summaryMarkdown = [
		mainSummary.markdown,
		"",
		"## Top Events",
		"",
		...buildTopRowsPreview(eventsReport, 15),
		"",
		"## Top Pages",
		"",
		...buildTopRowsPreview(pagesReport, 10),
		"",
		"## Top Traffic Sources",
		"",
		...buildTopRowsPreview(sourcesReport, 10),
	].join("\n");

	return {
		reply: [
			`/analytics overview for property ${propertyId}.`,
			`range=${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
			`activeUsers=${mainSummary.totals.activeUsers ?? "0"}`,
			`sessions=${mainSummary.totals.sessions ?? "0"}`,
			`pageViews=${mainSummary.totals.screenPageViews ?? "0"}`,
			`events=${mainSummary.totals.eventCount ?? "0"}`,
			`engagementRate=${mainSummary.totals.engagementRate ?? "0"}`,
			`bounceRate=${mainSummary.totals.bounceRate ?? "0"}`,
			`topEvents=${(eventsReport.rows ?? []).slice(0, 5).map((r) => r.dimensionValues?.[0]?.value).filter(Boolean).join(",")}`,
			`topPages=${(pagesReport.rows ?? []).slice(0, 5).map((r) => r.dimensionValues?.[0]?.value).filter(Boolean).join(",")}`,
		].join("\n"),
		requestPayload: { kind: "preset", preset: "overview" },
		responsePayload: {
			mainReport: mainReport as JsonObject,
			eventsReport: eventsReport as JsonObject,
			pagesReport: pagesReport as JsonObject,
			sourcesReport: sourcesReport as JsonObject,
		},
		summaryMarkdown,
		legacyReportArtifact: mainReport as JsonObject,
	};
}

async function executeCohortPreset(
	propertyId: string,
	accessToken: string,
	dateRange: AnalyticsDateRange,
): Promise<AnalyticsExecutionResult> {
	const daySpan = Math.max(1, Math.ceil(
		(new Date(dateRange.endDate).getTime() - new Date(dateRange.startDate).getTime()) / (1000 * 60 * 60 * 24),
	));
	const granularity = daySpan <= 14 ? "DAILY" : "WEEKLY";

	const nthDimension = granularity === "WEEKLY" ? "cohortNthWeek" : "cohortNthDay";
	const endOffset = granularity === "WEEKLY" ? Math.max(1, Math.floor(daySpan / 7)) : daySpan;

	const cohortRequest: JsonObject = {
		dimensions: [{ name: "cohort" }, { name: nthDimension }],
		metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }],
		cohortSpec: {
			cohorts: [
				{
					name: "all_users",
					dimension: "firstSessionDate",
					dateRange: { startDate: dateRange.startDate, endDate: dateRange.endDate },
				},
			],
			cohortsRange: {
				granularity,
				endOffset,
			},
			cohortReportSettings: { accumulate: false },
		},
	};

	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase: GOOGLE_ANALYTICS_DATA_API_BETA_BASE,
		path: `/properties/${propertyId}:runReport`,
		accessToken,
		body: cohortRequest,
	});

	const rows = report.rows ?? [];
	const retentionEntries: string[] = [];
	for (const row of rows) {
		const period = row.dimensionValues?.[1]?.value ?? "?";
		const activeUsers = Number(row.metricValues?.[0]?.value ?? 0);
		const totalUsers = Number(row.metricValues?.[1]?.value ?? 1);
		const retentionRate = totalUsers > 0 ? ((activeUsers / totalUsers) * 100).toFixed(1) : "0.0";
		const periodLabel = granularity === "WEEKLY" ? `Week ${period}` : `Day ${period}`;
		retentionEntries.push(`- ${periodLabel}: ${activeUsers.toLocaleString("en-US")} / ${totalUsers.toLocaleString("en-US")} (${retentionRate}%)`);
	}

	if (retentionEntries.length === 0) {
		retentionEntries.push("- no cohort data available for this range");
	}

	const summaryMarkdown = [
		"# Analytics Explore: Cohort Retention",
		"",
		`- property: ${propertyId}`,
		`- range: ${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
		`- granularity: ${granularity.toLowerCase()}`,
		`- periods: ${rows.length}`,
		"",
		"## Retention by Period",
		"",
		...retentionEntries,
	].join("\n");

	return {
		reply: [
			`/analytics cohort for property ${propertyId}.`,
			`range=${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
			`granularity=${granularity.toLowerCase()}`,
			`periods=${rows.length}`,
			"",
			"## Retention",
			"",
			...retentionEntries,
		].join("\n"),
		requestPayload: { kind: "preset", preset: "cohort", request: cohortRequest },
		responsePayload: report as JsonObject,
		summaryMarkdown,
		legacyReportArtifact: report as JsonObject,
	};
}

async function executeExploreRequest(
	propertyId: string,
	accessToken: string,
	exploreName: string,
	dateRange: AnalyticsDateRange,
	exploreDir: string,
): Promise<AnalyticsExecutionResult> {
	const definition = await loadExploreDefinition(exploreDir, exploreName);
	const apiKind = typeof definition.kind === "string" ? definition.kind : "report";
	const requestBody: JsonObject = { ...cloneJsonObject(definition) };
	delete requestBody.kind;
	delete requestBody.name;
	delete requestBody.description;

	const dateRanges = [{ startDate: dateRange.startDate, endDate: dateRange.endDate }] as JsonValue;
	if (!Array.isArray(requestBody.dateRanges)) {
		requestBody.dateRanges = dateRanges;
	}

	const displayName = typeof definition.name === "string" ? definition.name : exploreName;
	const description = typeof definition.description === "string" ? definition.description : "";

	let apiPath: string;
	let apiBase: string;
	switch (apiKind) {
		case "pivot":
			apiBase = GOOGLE_ANALYTICS_DATA_API_BETA_BASE;
			apiPath = `/properties/${propertyId}:runPivotReport`;
			break;
		case "funnel":
			apiBase = GOOGLE_ANALYTICS_DATA_API_ALPHA_BASE;
			apiPath = `/properties/${propertyId}:runFunnelReport`;
			break;
		case "realtime":
			apiBase = GOOGLE_ANALYTICS_DATA_API_BETA_BASE;
			apiPath = `/properties/${propertyId}:runRealtimeReport`;
			break;
		default:
			apiBase = GOOGLE_ANALYTICS_DATA_API_BETA_BASE;
			apiPath = `/properties/${propertyId}:runReport`;
			break;
	}

	const report = await runAnalyticsRequest<GoogleAnalyticsReportResponse>({
		apiBase,
		path: apiPath,
		accessToken,
		body: requestBody,
	});

	const rowCount = report.rowCount ?? report.rows?.length ?? 0;
	const topEntries = buildTopRowsPreview(report, 15);

	const summaryMarkdown = [
		`# Explore: ${displayName}`,
		"",
		`- property: ${propertyId}`,
		`- range: ${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
		`- api: ${apiKind}`,
		...(description ? [`- description: ${description}`] : []),
		`- rows: ${rowCount}`,
		"",
		"## Results",
		"",
		...topEntries,
	].join("\n");

	return {
		reply: [
			`/analytics explore ${exploreName} for property ${propertyId}.`,
			`name=${displayName}`,
			`range=${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
			`api=${apiKind}`,
			`rows=${rowCount}`,
			"",
			"## Results",
			"",
			...topEntries,
		].join("\n"),
		requestPayload: { kind: "explore", explore: exploreName, api: apiKind, request: requestBody },
		responsePayload: report as JsonObject,
		summaryMarkdown,
		legacyReportArtifact: report as JsonObject,
	};
}

async function loadExploreDefinition(exploreDir: string, name: string): Promise<JsonObject> {
	const safeName = path.basename(name).replace(/\.json$/i, "");
	const filePath = path.join(exploreDir, `${safeName}.json`);
	const resolved = path.resolve(filePath);
	if (!resolved.startsWith(path.resolve(exploreDir))) {
		throw new Error(`Invalid explore name '${name}'.`);
	}

	let content: string;
	try {
		content = await readFile(resolved, "utf8");
	} catch {
		const available = await listSavedExplores(exploreDir);
		const hint = available.length > 0
			? `Available explores: ${available.join(", ")}.`
			: `No explores found in ${path.relative(process.cwd(), exploreDir)}/. Add a .json file to get started.`;
		throw new Error(`Explore '${safeName}' not found at ${path.relative(process.cwd(), resolved)}. ${hint}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in explore file '${safeName}.json'.`);
	}

	if (!isJsonObject(parsed)) {
		throw new Error(`Explore file '${safeName}.json' must contain a JSON object.`);
	}

	return parsed;
}

async function listSavedExplores(exploreDir: string): Promise<string[]> {
	try {
		const entries = await readdir(exploreDir);
		return entries
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => entry.replace(/\.json$/i, ""))
			.sort();
	} catch {
		return [];
	}
}

function buildTopRowsPreview(report: GoogleAnalyticsReportResponse, limit: number): string[] {
	const rows = report.rows ?? [];
	if (rows.length === 0) {
		return ["- no data"];
	}

	const dimHeaders = (report.dimensionHeaders ?? []).map((h) => h.name);
	const metricHeaders = (report.metricHeaders ?? []).map((h) => h.name);

	return rows.slice(0, limit).map((row, index) => {
		const dims = (row.dimensionValues ?? []).map((v) => v.value).join(" / ");
		const metrics = (row.metricValues ?? [])
			.map((v, i) => `${metricHeaders[i] ?? "metric"}: ${formatMetricValue(metricHeaders[i] ?? "", v.value)}`)
			.join(", ");
		return `${index + 1}. **${dims}** — ${metrics}`;
	});
}

function parseAnalyticsDateRange(args: string): AnalyticsDateRange {
	const trimmed = args.trim();
	if (!trimmed) {
		return buildTrailingDayRange(DEFAULT_LOOKBACK_DAYS);
	}

	const relativeMatch = trimmed.match(/^(?:last:?)?(\d{1,3})d(?:ays)?$/i);
	if (relativeMatch) {
		const days = clampLookback(Number(relativeMatch[1]));
		return buildTrailingDayRange(days);
	}

	const customMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/);
	if (customMatch) {
		return {
			label: "custom",
			startDate: customMatch[1],
			endDate: customMatch[2],
		};
	}

	throw new Error(buildHelpText());
}

function buildTrailingDayRange(days: number): AnalyticsDateRange {
	const endDate = new Date();
	const startDate = new Date();
	startDate.setUTCDate(endDate.getUTCDate() - Math.max(0, days - 1));
	return {
		label: `last-${days}-days`,
		startDate: formatDate(startDate),
		endDate: formatDate(endDate),
	};
}

function clampLookback(days: number): number {
	if (!Number.isFinite(days) || days <= 0) {
		return DEFAULT_LOOKBACK_DAYS;
	}

	return Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.floor(days)));
}

function formatDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function serializeDateRange(dateRange: AnalyticsDateRange): JsonObject {
	return {
		label: dateRange.label,
		startDate: dateRange.startDate,
		endDate: dateRange.endDate,
	};
}

function normalizePrivateKey(value: string): string {
	return value.replace(/\\n/g, "\n").trim();
}

async function getGoogleAccessToken(input: {
	serviceAccountEmail: string;
	serviceAccountPrivateKey: string;
}): Promise<string> {
	const assertion = buildJwtAssertion(input);
	const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
	});

	if (!response.ok) {
		throw new Error(`Google OAuth token request failed with ${response.status}: ${await response.text()}`);
	}

	const payload = await response.json() as GoogleTokenResponse;
	if (!payload.access_token) {
		throw new Error("Google OAuth token response did not include an access token.");
	}

	return payload.access_token;
}

function buildJwtAssertion(input: {
	serviceAccountEmail: string;
	serviceAccountPrivateKey: string;
}): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
	const payload = base64UrlEncodeJson({
		iss: input.serviceAccountEmail,
		scope: GOOGLE_ANALYTICS_SCOPE,
		aud: GOOGLE_OAUTH_TOKEN_URL,
		iat: now,
		exp: now + 3600,
	});
	const unsignedToken = `${header}.${payload}`;
	const signer = createSign("RSA-SHA256");
	signer.update(unsignedToken);
	signer.end();
	const signature = signer.sign(input.serviceAccountPrivateKey).toString("base64url");
	return `${unsignedToken}.${signature}`;
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function runAnalyticsRequest<ResponseType>(input: {
	apiBase: string;
	path: string;
	accessToken: string;
	method?: "GET" | "POST";
	body?: JsonObject;
	query?: Record<string, string>;
}): Promise<ResponseType> {
	const url = new URL(`${input.apiBase}${input.path}`);
	for (const [key, value] of Object.entries(input.query ?? {})) {
		url.searchParams.set(key, value);
	}

	const response = await fetch(url, {
		method: input.method ?? (input.body ? "POST" : "GET"),
		headers: {
			authorization: `Bearer ${input.accessToken}`,
			"content-type": "application/json",
		},
		body: input.body ? JSON.stringify(input.body) : undefined,
	});

	if (!response.ok) {
		throw new Error(`Google Analytics API request failed with ${response.status}: ${await response.text()}`);
	}

	return await response.json() as ResponseType;
}

async function listAdminResources(input: {
	propertyId: string;
	accessToken: string;
	resource: string;
	config: AdminResourceConfig;
}): Promise<{ items: JsonObject[] }> {
	const items: JsonObject[] = [];
	let pageToken: string | undefined;

	do {
		const response = await runAnalyticsRequest<Record<string, unknown>>({
			apiBase: input.config.apiBase,
			path: input.config.path(input.propertyId),
			accessToken: input.accessToken,
			method: "GET",
			query: {
				pageSize: "200",
				...(pageToken ? { pageToken } : {}),
			},
		});

		const pageItems = (response[input.config.responseKey] as unknown[] | undefined) ?? [];
		for (const item of pageItems) {
			if (isJsonObject(item)) {
				items.push(item);
			}
		}

		pageToken = typeof response.nextPageToken === "string" && response.nextPageToken ? response.nextPageToken : undefined;
	} while (pageToken);

	return { items };
}

function normalizeReportRequest(payload: JsonObject): JsonObject {
	const request = withDefaultDateRanges(payload, true);
	return normalizeCommonDataRequest(request, ["dimensions", "metrics"]);
}

function normalizePivotRequest(payload: JsonObject): JsonObject {
	const request = withDefaultDateRanges(payload, true);
	const normalized = normalizeCommonDataRequest(request, ["dimensions", "metrics", "pivots"]);
	return normalizeNumericStringFields(normalized, new Set(["limit", "offset"])) as JsonObject;
}

function normalizeRealtimeRequest(payload: JsonObject): JsonObject {
	const normalized = cloneJsonObject(payload);
	return normalizeCommonDataRequest(normalized, ["dimensions", "metrics"]);
}

function normalizeFunnelRequest(payload: JsonObject): JsonObject {
	const request = withDefaultDateRanges(payload, true);
	if (!isJsonObject(request.funnel)) {
		throw new Error("/analytics funnel requires a JSON payload with a funnel object.");
	}

	return normalizeNumericStringFields(cloneJsonObject(request), new Set(["limit", "offset"])) as JsonObject;
}

function withDefaultDateRanges(payload: JsonObject, useDefaultLookback: boolean): JsonObject {
	const request = cloneJsonObject(payload);
	const daysValue = typeof request.days === "number" ? request.days : undefined;
	const startDate = typeof request.startDate === "string" ? request.startDate : undefined;
	const endDate = typeof request.endDate === "string" ? request.endDate : undefined;

	delete request.days;
	delete request.startDate;
	delete request.endDate;

	if (Array.isArray(request.dateRanges)) {
		return request;
	}

	if (daysValue !== undefined) {
		const range = buildTrailingDayRange(clampLookback(daysValue));
		request.dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
		return request;
	}

	if (startDate && endDate) {
		request.dateRanges = [{ startDate, endDate }];
		return request;
	}

	if (useDefaultLookback) {
		const range = buildTrailingDayRange(DEFAULT_LOOKBACK_DAYS);
		request.dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
	}

	return request;
}

function normalizeCommonDataRequest(payload: JsonObject, _keysToNormalize: string[]): JsonObject {
	const normalized = cloneJsonObject(payload);
	if (Array.isArray(normalized.dimensions)) {
		normalized.dimensions = normalizeNamedArray(normalized.dimensions);
	}
	if (Array.isArray(normalized.metrics)) {
		normalized.metrics = normalizeNamedArray(normalized.metrics);
	}

	return normalizeNumericStringFields(normalized, new Set(["limit", "offset"])) as JsonObject;
}

function normalizeNamedArray(values: JsonValue[]): JsonValue[] {
	return values.map((value) => {
		if (typeof value === "string") {
			return { name: value };
		}

		return value;
	});
}

function normalizeNumericStringFields(value: JsonValue, fieldNames: Set<string>): JsonValue {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeNumericStringFields(item, fieldNames));
	}

	if (!isJsonObject(value)) {
		return value;
	}

	const normalized: JsonObject = {};
	for (const [key, childValue] of Object.entries(value)) {
		if (typeof childValue === "number" && fieldNames.has(key)) {
			normalized[key] = String(Math.trunc(childValue));
			continue;
		}

		normalized[key] = normalizeNumericStringFields(childValue, fieldNames);
	}

	return normalized;
}

function buildReportSummary(
	report: GoogleAnalyticsReportResponse,
	dateRange: AnalyticsDateRange | string,
	propertyId: string,
	title: string,
): {
	rowCount: number;
	totals: Record<string, string>;
	markdown: string;
} {
	const metricNames = (report.metricHeaders ?? []).map((metric) => metric.name);
	const totalValues = report.totals?.[0]?.metricValues ?? [];
	const totals = Object.fromEntries(
		metricNames.map((metricName, index) => [metricName, formatMetricValue(metricName, totalValues[index]?.value ?? "0")]),
	);
	const rowCount = report.rowCount ?? report.rows?.length ?? 0;
	const rangeLabel = typeof dateRange === "string"
		? dateRange
		: `${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`;
	const markdown = [
		`# ${title}`,
		"",
		`- property: ${propertyId}`,
		`- range: ${rangeLabel}`,
		`- rows: ${rowCount}`,
		"",
		"## Dimensions",
		"",
		...((report.dimensionHeaders ?? []).map((dimension) => `- ${dimension.name}`)),
		"",
		"## Metrics",
		"",
		...(metricNames.length > 0 ? metricNames.map((metricName) => `- ${metricName}`) : ["- none"]),
		"",
		"## Totals",
		"",
		...(metricNames.length > 0
			? metricNames.map((metricName) => `- ${metricName}: ${totals[metricName] ?? "0"}`)
			: ["- none"]),
	].join("\n");

	return {
		rowCount,
		totals,
		markdown,
	};
}

function buildGenericTabularSummary(input: {
	title: string;
	propertyId: string;
	dateRangeLabel: string;
	report: GoogleAnalyticsReportResponse;
}): string {
	return [
		`# ${input.title}`,
		"",
		`- property: ${input.propertyId}`,
		`- range: ${input.dateRangeLabel}`,
		`- rows: ${input.report.rowCount ?? input.report.rows?.length ?? 0}`,
		"",
		"## Dimensions",
		"",
		...buildHeaderList(input.report.dimensionHeaders),
		"",
		"## Metrics",
		"",
		...buildHeaderList(input.report.metricHeaders),
	].join("\n");
}

function buildHeaderList(headers: Array<{ name: string }> | undefined): string[] {
	if (!headers || headers.length === 0) {
		return ["- none"];
	}

	return headers.map((header) => `- ${header.name}`);
}

function buildHeaderPreview(report: GoogleAnalyticsReportResponse | undefined): string[] {
	if (!report) {
		return ["- none"];
	}

	return [
		...buildHeaderList(report.dimensionHeaders),
		"",
		...buildHeaderList(report.metricHeaders),
	];
}

function formatMetricValue(metricName: string, value: string): string {
	const numericValue = Number(value);
	if (!Number.isFinite(numericValue)) {
		return value;
	}

	if (/rate/i.test(metricName)) {
		return `${(numericValue * 100).toFixed(2)}%`;
	}

	if (Number.isInteger(numericValue)) {
		return numericValue.toLocaleString("en-US");
	}

	return numericValue.toFixed(2);
}

function filterMetadata(metadata: GoogleAnalyticsMetadataResponse, searchQuery?: string): GoogleAnalyticsMetadataResponse {
	if (!searchQuery) {
		return metadata;
	}

	const query = searchQuery.trim().toLowerCase();
	const matches = (item: GoogleAnalyticsMetadataItem): boolean => {
		return [item.apiName, item.uiName, item.description, item.category]
			.filter((value): value is string => typeof value === "string")
			.some((value) => value.toLowerCase().includes(query));
	};

	return {
		...metadata,
		dimensions: (metadata.dimensions ?? []).filter(matches),
		metrics: (metadata.metrics ?? []).filter(matches),
	};
}

function buildMetadataPreview(items: GoogleAnalyticsMetadataItem[]): string[] {
	if (items.length === 0) {
		return ["- none"];
	}

	return items.slice(0, MAX_METADATA_PREVIEW_ITEMS).map((item) => {
		const pieces = [item.apiName ?? "unknown"];
		if (item.uiName) {
			pieces.push(item.uiName);
		}
		if (item.customDefinition) {
			pieces.push("custom");
		}
		return `- ${pieces.join(" | ")}`;
	});
}

function filterAdminItems(items: JsonObject[], searchQuery?: string): JsonObject[] {
	if (!searchQuery) {
		return items;
	}

	const query = searchQuery.trim().toLowerCase();
	return items.filter((item) => JSON.stringify(item).toLowerCase().includes(query));
}

function buildAdminPreview(items: JsonObject[]): string[] {
	if (items.length === 0) {
		return ["- none"];
	}

	return items.slice(0, MAX_ADMIN_PREVIEW_ITEMS).map((item) => `- ${summarizeAdminItem(item)}`);
}

function summarizeAdminItem(item: JsonObject): string {
	const candidates = [
		item.displayName,
		item.parameterName,
		item.eventName,
		item.name,
		item.resourceName,
		item.measurementId,
		item.type,
	];
	const primary = candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
	if (primary) {
		return primary;
	}

	return JSON.stringify(item);
}

function describeRequestDateRanges(dateRanges: JsonValue | undefined): string {
	if (!Array.isArray(dateRanges) || dateRanges.length === 0) {
		return "none";
	}

	const parts = dateRanges
		.filter(isJsonObject)
		.map((range) => {
			const startDate = typeof range.startDate === "string" ? range.startDate : "?";
			const endDate = typeof range.endDate === "string" ? range.endDate : "?";
			return `${startDate}..${endDate}`;
		});

	return parts.join(", ");
}

function buildHelpText(): string {
	const presetNames = Object.keys(PRESET_REPORT_CONFIG).join(", ");
	return [
		"Unsupported /analytics args.",
		"Use one of:",
		"- '/analytics'",
		"- '/analytics 30d'",
		"- '/analytics 2026-03-01 2026-03-21'",
		`- '/analytics <preset> [date]' where <preset> is one of: ${presetNames}`,
		"- '/analytics explore <name> [date]' — load a saved report from apps/growth-genius/data/explore/<name>.json",
		"- '/analytics metadata [search]'",
		`- '/analytics admin <resource>' where <resource> is one of ${Object.keys(ADMIN_RESOURCE_CONFIG).join(", ")}`,
		"- '/analytics report {json}'",
		"- '/analytics pivot {json}'",
		"- '/analytics funnel {json}'",
		"- '/analytics realtime {json}'",
		"- '/analytics help'",
		"Explicit slash-command report-style runs (`/analytics`, `/a`, presets, explicit date ranges, and `/analytics explore <name>`) also execute configured external endpoints from apps/growth-genius/data/endpoints/*.json.",
	].join("\n");
}

function looksLikeAnalyticsNaturalLanguageRequest(content: string): boolean {
	if (/^\/analytics\b/.test(content)) {
		return false;
	}

	return (
		/(how did we do|how are we doing|how did .* do|performance|analytics|ga4|traffic|sessions|active users|new users|engagement|bounce rate|top pages|top page|top events|events|traffic sources|sources|campaign|landing page|landing pages|device|devices|browser|geo|country|city|retention|realtime|live users|right now)/i.test(content) &&
		/(yesterday|today|last\s+\d+\s+days?|last\s+week|past\s+week|last\s+month|past\s+month|right now|currently|this week|this month|daily|weekly|monthly|top|best|worst|how did|how are)/i.test(content)
	);
}

function inferAnalyticsPreset(content: string): string {
	if (/\b(realtime|right now|currently|live users?)\b/i.test(content)) {
		return "realtime";
	}
	if (/\b(top events?|events?)\b/i.test(content)) {
		return "events";
	}
	if (/\b(top pages?|pages?|content)\b/i.test(content)) {
		return "pages";
	}
	if (/\b(source|sources|traffic|campaign|acquisition)\b/i.test(content)) {
		return "sources";
	}
	if (/\b(device|devices|browser|mobile|desktop)\b/i.test(content)) {
		return "devices";
	}
	if (/\b(country|city|geo|geography|region)\b/i.test(content)) {
		return "geo";
	}
	if (/\b(landing|entry page|entry pages)\b/i.test(content)) {
		return "landing";
	}
	if (/\b(engagement|bounce|session duration|engaged)\b/i.test(content)) {
		return "engagement";
	}

	return "overview";
}

function inferAnalyticsDateRangeArgs(content: string): string | null {
	if (/\b(realtime|right now|currently|live users?)\b/i.test(content)) {
		return null;
	}

	const explicitDays = content.match(/\b(?:last|past)\s+(\d{1,2})\s+days?\b/i);
	if (explicitDays) {
		return `${clampLookback(Number(explicitDays[1]))}d`;
	}

	if (/\byesterday\b/i.test(content)) {
		const yesterday = new Date();
		yesterday.setUTCDate(yesterday.getUTCDate() - 1);
		const value = formatDate(yesterday);
		return `${value} ${value}`;
	}

	if (/\btoday\b/i.test(content)) {
		const today = formatDate(new Date());
		return `${today} ${today}`;
	}

	if (/\b(last|past)\s+week\b/i.test(content) || /\bthis week\b/i.test(content)) {
		return "7d";
	}

	if (/\b(last|past)\s+month\b/i.test(content) || /\bthis month\b/i.test(content)) {
		return "30d";
	}

	if (/\bweekly\b/i.test(content)) {
		return "7d";
	}

	if (/\bmonthly\b/i.test(content)) {
		return "30d";
	}

	if (/\bdaily\b/i.test(content)) {
		return "1d";
	}

	return "7d";
}

const NL_ANALYTICS_AVAILABLE_PRESETS = Object.keys(PRESET_REPORT_CONFIG);

const NL_ANALYTICS_SYSTEM_PROMPT = [
	"You classify whether a user message is asking about website/app analytics and, if so, translate it into a structured analytics command.",
	"",
	"Return strict JSON only with these keys:",
	"  isAnalytics (boolean) — true if the message is asking about analytics, traffic, performance, users, events, pages, etc.",
	"  preset (string|null) — the best matching preset from the available list, or null if not analytics.",
	`  Available presets: ${NL_ANALYTICS_AVAILABLE_PRESETS.join(", ")}.`,
	"  dateArgs (string|null) — the date range argument. Formats:",
	"    - Relative: '<N>d' for last N days (e.g. '7d', '30d', '1d').",
	"    - Exact day: 'YYYY-MM-DD YYYY-MM-DD' for a specific date range.",
	"    - null to use the default (7 days).",
	"  subject (string|null) — a short label for the analytics topic (e.g. 'analytics-overview', 'analytics-events').",
	"  confidence (string) — 'high', 'medium', or 'low'.",
	"",
	"Mapping guidance:",
	"  - General performance / 'how did we do' → overview",
	"  - Events, top events, clicks, conversions → events",
	"  - Pages, top pages, content → pages",
	"  - Landing pages, entry pages → landing",
	"  - Traffic, sources, campaigns, acquisition, referrals → sources",
	"  - Devices, browser, mobile, desktop → devices",
	"  - Country, city, geography, region → geo",
	"  - Engagement, bounce rate, session duration → engagement",
	"  - Realtime, live, right now → realtime (dateArgs must be null)",
	"  - Journeys, paths, user flow → journeys",
	"  - Retention, cohort → cohort",
	"",
	"Date guidance:",
	`  - Today's date is ${new Date().toISOString().slice(0, 10)}.`,
	"  - 'yesterday' → compute the exact date and return 'YYYY-MM-DD YYYY-MM-DD' with both dates the same.",
	"  - 'today' → compute today's date and return 'YYYY-MM-DD YYYY-MM-DD' with both dates the same.",
	"  - 'last week' or 'past week' → '7d'.",
	"  - 'last month' or 'past month' → '30d'.",
	"  - 'last N days' → '<N>d'.",
	"  - If no time reference, return null (defaults to 7d).",
	"",
	"Examples:",
	"  - 'how did we do yesterday' -> {\"isAnalytics\": true, \"preset\": \"overview\", \"dateArgs\": \"YYYY-MM-DD YYYY-MM-DD\", \"subject\": \"analytics-overview\", \"confidence\": \"high\"}",
	"  - 'what were our top pages last 30 days' -> {\"isAnalytics\": true, \"preset\": \"pages\", \"dateArgs\": \"30d\", \"subject\": \"analytics-pages\", \"confidence\": \"high\"}",
	"  - 'which sources are driving traffic this month' -> {\"isAnalytics\": true, \"preset\": \"sources\", \"dateArgs\": \"30d\", \"subject\": \"analytics-sources\", \"confidence\": \"high\"}",
	"  - 'show live users right now' -> {\"isAnalytics\": true, \"preset\": \"realtime\", \"dateArgs\": null, \"subject\": \"analytics-realtime\", \"confidence\": \"high\"}",
	"  - 'what countries are users coming from' -> {\"isAnalytics\": true, \"preset\": \"geo\", \"dateArgs\": null, \"subject\": \"analytics-geo\", \"confidence\": \"medium\"}",
	"",
	"If the message is NOT about analytics, return: {\"isAnalytics\": false, \"preset\": null, \"dateArgs\": null, \"subject\": null, \"confidence\": \"high\"}",
].join("\n");

interface NLAnalyticsModelResponse {
	isAnalytics: boolean;
	preset: string | null;
	dateArgs: string | null;
	subject: string | null;
	confidence: "low" | "medium" | "high";
}

async function translateNaturalLanguageAnalyticsIntent(content: string, plugin?: PluginContract): Promise<AnalyticsNaturalLanguageIntent | null> {
	const model = getAnalyticsIntentModel(plugin);
	try {
		const response = await generateText({
			task: "analytics-intent",
			model,
			plugin,
			input: [
				{
					role: "system",
					content: [{ type: "input_text", text: NL_ANALYTICS_SYSTEM_PROMPT }],
				},
				{
					role: "user",
					content: [{ type: "input_text", text: content }],
				},
			],
		});

		const parsed = parseNLAnalyticsModelResponse(response.text);
		if (!parsed || !parsed.isAnalytics || !parsed.preset) {
			return null;
		}
		if (parsed.confidence === "low") {
			return null;
		}
		if (!NL_ANALYTICS_AVAILABLE_PRESETS.includes(parsed.preset)) {
			return null;
		}

		const args = parsed.dateArgs ? `${parsed.preset} ${parsed.dateArgs}` : parsed.preset;

		return {
			args,
			subject: parsed.subject ?? `analytics-${parsed.preset}`,
			reason: `analytics-nl-model-${parsed.confidence}`,
			confidence: parsed.confidence,
			matchedBy: "model",
			preset: parsed.preset,
			dateArgs: parsed.dateArgs,
		};
	} catch {
		return null;
	}
}

function buildAnalyticsInterpretationDiagnostics(intent: AnalyticsNaturalLanguageIntent): string[] {
	return [
		`nlMatchedBy=${intent.matchedBy ?? "unknown"}`,
		`nlConfidence=${intent.confidence ?? "unknown"}`,
		`nlSubject=${intent.subject}`,
		`nlPreset=${intent.preset ?? "unknown"}`,
		`nlDateArgs=${intent.dateArgs ?? "default"}`,
		`nlArgs=${intent.args}`,
	];
}

async function generateNaturalLanguageAnalyticsReply(input: {
	originalPrompt: string;
	analyticsArgs: string;
	summaryMarkdown: string;
	fallbackReply: string;
	plugin: PluginContract;
}): Promise<string> {
	const model = getAnalyticsReplyModel(input.plugin);
	try {
		const response = await generateText({
			task: "analytics-reply",
			model,
			plugin: input.plugin,
			input: [
				{
					role: "system",
					content: [
						{
							type: "input_text",
							text: [
								"You answer a user's analytics question using the provided analytics summary, which may include Google Analytics and external endpoint results.",
								"Answer the user's actual question directly, not the command that was run.",
								"Use concrete numbers from the summary when available.",
								"If the data only partially answers the question, say that briefly and explain what the current result does show.",
								"Keep the answer concise, specific, and useful for Discord.",
								"Do not mention internal prompts, models, routing, or implementation details.",
								"Do not invent metrics that are not present in the summary.",
								"Stay under 1200 characters.",
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
								userQuestion: input.originalPrompt,
								resolvedAnalyticsArgs: input.analyticsArgs,
								analyticsSummary: input.summaryMarkdown,
							}),
						},
					],
				},
			],
		});

		const text = response.text.trim();
		return text || input.fallbackReply;
	} catch {
		return input.fallbackReply;
	}
}

function getAnalyticsSummaryModel(plugin?: PluginContract): string {
	return resolveAiTextModel("analytics-summary", { plugin });
}

function getAnalyticsIntentModel(plugin?: PluginContract): string {
	return resolveAiTextModel("analytics-intent", { plugin });
}

function getAnalyticsReplyModel(plugin?: PluginContract): string {
	return resolveAiTextModel("analytics-reply", { plugin });
}

function parseNLAnalyticsModelResponse(text: string): NLAnalyticsModelResponse | null {
	const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	if (!normalized) {
		return null;
	}

	try {
		const parsed = JSON.parse(normalized) as Record<string, unknown>;
		if (typeof parsed.isAnalytics !== "boolean") {
			return null;
		}
		if (parsed.preset !== null && typeof parsed.preset !== "string") {
			return null;
		}
		if (parsed.dateArgs !== null && typeof parsed.dateArgs !== "string") {
			return null;
		}
		const confidence = parsed.confidence;
		if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
			return null;
		}

		return {
			isAnalytics: parsed.isAnalytics,
			preset: typeof parsed.preset === "string" ? parsed.preset.trim().toLowerCase() : null,
			dateArgs: typeof parsed.dateArgs === "string" ? parsed.dateArgs.trim() : null,
			subject: typeof parsed.subject === "string" ? parsed.subject.trim() : null,
			confidence,
		};
	} catch {
		return null;
	}
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function shouldExecuteExternalEndpoints(input: {
	operation: AnalyticsOperationRequest;
	requestSource: string;
}): boolean {
	if (input.requestSource !== "/analytics") {
		return false;
	}

	return input.operation.kind === "comprehensive"
		|| input.operation.kind === "legacy-report"
		|| input.operation.kind === "preset"
		|| input.operation.kind === "explore";
}

async function executeConfiguredExternalEndpoints(input: {
	endpointsDir: string;
	operation: AnalyticsOperationRequest;
	propertyId: string;
	promptText: string;
	plugin: PluginContract;
}): Promise<ExternalEndpointExecutionResult[]> {
	const endpointIds = await listSavedExternalEndpoints(input.endpointsDir);
	if (endpointIds.length === 0) {
		return [];
	}

	const context = buildExternalEndpointTemplateContext(input.operation, input.propertyId);
	const definitions = await Promise.all(
		endpointIds.map(async (endpointId) => ({
			endpointId,
			definition: await loadExternalEndpointDefinition(input.endpointsDir, endpointId),
		})),
	);
	const enabledEndpoints = definitions.filter(({ definition }) => definition.enabled !== false);

	const results = await Promise.all(
		enabledEndpoints.map(({ endpointId, definition }) =>
			executeExternalEndpointDefinition({
				endpointId,
				definition,
				context,
				promptText: input.promptText,
				plugin: input.plugin,
			}),
		),
	);

	return results;
}

function buildExternalEndpointTemplateContext(operation: AnalyticsOperationRequest, propertyId: string): Record<string, string> {
	return {
		propertyId,
		operationKind: operation.kind,
		startDate: operation.dateRange?.startDate ?? "",
		endDate: operation.dateRange?.endDate ?? "",
		dateLabel: operation.dateRange?.label ?? "",
		presetName: operation.presetName ?? "",
		exploreName: operation.exploreName ?? "",
	};
}

async function executeExternalEndpointDefinition(input: {
	endpointId: string;
	definition: ExternalEndpointDefinition;
	context: Record<string, string>;
	promptText: string;
	plugin: PluginContract;
}): Promise<ExternalEndpointExecutionResult> {
	const apiKeyValue = process.env[input.definition.apiKeyEnv]?.trim();
	if (!apiKeyValue) {
		throw new Error(`Configured analytics endpoint '${input.endpointId}' is missing env var ${input.definition.apiKeyEnv}.`);
	}

	const displayName = input.definition.name?.trim() || input.endpointId;
	const method = resolveExternalEndpointMethod(input.definition.method, input.definition.body);
	const url = interpolateTemplateString(input.definition.url, input.context);
	const headers = convertObjectToStringRecord(interpolateOptionalObject(input.definition.headers, input.context), "headers");
	const query = convertObjectToStringRecord(interpolateOptionalObject(input.definition.query, input.context), "query");
	const bodyResult = await buildExternalEndpointBody({
		definition: input.definition,
		context: input.context,
		promptText: input.promptText,
		plugin: input.plugin,
	});
	const body = bodyResult.body;

	const requestPayload: JsonObject = {
		endpointId: input.endpointId,
		name: displayName,
		url,
		method,
		apiKeyEnv: input.definition.apiKeyEnv,
		query: query as JsonValue,
		headers: headers as JsonValue,
		body: body ?? null,
		parameterResolution: bodyResult.parameterResolution,
	};

	try {
		const response = await runExternalEndpointRequest({
			url,
			method,
			apiKey: apiKeyValue,
			headers,
			query,
			body,
		});
		return {
			endpointId: input.endpointId,
			displayName,
			description: input.definition.description,
			method,
			url,
			apiKeyEnv: input.definition.apiKeyEnv,
			success: response.success,
			statusCode: response.statusCode,
			contentType: response.contentType,
			summaryText: buildExternalEndpointSummaryText({
				success: response.success,
				statusCode: response.statusCode,
				responseBody: response.body,
				definition: input.definition,
				errorMessage: response.errorMessage,
			}),
			requestPayload,
			responsePayload: {
				ok: response.success,
				statusCode: response.statusCode,
				contentType: response.contentType ?? null,
				...(response.errorMessage ? { error: response.errorMessage } : {}),
				body: response.body,
			},
		};
	} catch (error) {
		const errorMessage = formatErrorMessage(error);
		return {
			endpointId: input.endpointId,
			displayName,
			description: input.definition.description,
			method,
			url,
			apiKeyEnv: input.definition.apiKeyEnv,
			success: false,
			summaryText: `error | ${truncateString(errorMessage, 200)}`,
			requestPayload,
			responsePayload: {
				ok: false,
				error: errorMessage,
				body: null,
			},
		};
	}
}

async function runExternalEndpointRequest(input: {
	url: string;
	method: string;
	apiKey: string;
	headers: Record<string, string>;
	query: Record<string, string>;
	body?: JsonValue;
}): Promise<{
	success: boolean;
	statusCode: number;
	contentType?: string;
	body: JsonValue;
	errorMessage?: string;
}> {
	const url = new URL(input.url);
	for (const [key, value] of Object.entries(input.query)) {
		url.searchParams.set(key, value);
	}

	if ((input.method === "GET" || input.method === "DELETE") && input.body !== undefined) {
		throw new Error(`Configured analytics endpoint ${url.toString()} cannot send a request body with ${input.method}.`);
	}

	const requestHeaders: Record<string, string> = {
		...input.headers,
		"x-api-key": input.apiKey,
	};
	if (input.body !== undefined && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
		requestHeaders["content-type"] = "application/json";
	}

	const response = await fetch(url, {
		method: input.method,
		headers: requestHeaders,
		body: input.body === undefined ? undefined : JSON.stringify(input.body),
		signal: AbortSignal.timeout(15_000),
	});

	const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
	const bodyText = await response.text();
	const body = parseHttpResponseBody(contentType, bodyText);

	return {
		success: response.ok,
		statusCode: response.status,
		contentType,
		body,
		errorMessage: response.ok ? undefined : `HTTP ${response.status}`,
	};
}

function parseHttpResponseBody(contentType: string | undefined, bodyText: string): JsonValue {
	const trimmed = bodyText.trim();
	if (!trimmed) {
		return null;
	}

	if (contentType?.includes("json") || /^[\[{]/.test(trimmed)) {
		try {
			return JSON.parse(trimmed) as JsonValue;
		} catch {
			return truncateString(trimmed, 1000);
		}
	}

	return truncateString(trimmed, 1000);
}

function buildExternalEndpointSummaryText(input: {
	success: boolean;
	statusCode: number;
	responseBody: JsonValue;
	definition: ExternalEndpointDefinition;
	errorMessage?: string;
}): string {
	if (!input.success) {
		const failureDetail = input.errorMessage ? ` | ${input.errorMessage}` : "";
		return `error (${input.statusCode})${failureDetail}`;
	}

	const preview = summarizeExternalEndpointBody(input.responseBody, input.definition.summaryFields);
	return preview ? `ok (${input.statusCode}) | ${preview}` : `ok (${input.statusCode})`;
}

function summarizeExternalEndpointBody(body: JsonValue, summaryFields?: string[]): string {
	if (summaryFields && summaryFields.length > 0) {
		const selected = summaryFields
			.map((field) => {
				const value = getJsonPathValue(body, field);
				if (value === undefined) {
					return null;
				}
				return `${field}=${summarizeJsonPrimitive(value)}`;
			})
			.filter((value): value is string => Boolean(value));
		if (selected.length > 0) {
			return selected.join(", ");
		}
	}

	if (Array.isArray(body)) {
		return `items=${body.length}`;
	}

	if (isJsonObject(body)) {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(body)) {
			if (parts.length >= 4) {
				break;
			}
			if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				parts.push(`${key}=${summarizeJsonPrimitive(value)}`);
				continue;
			}
			if (Array.isArray(value)) {
				parts.push(`${key}[${value.length}]`);
			}
		}
		return parts.join(", ") || `keys=${Object.keys(body).slice(0, 6).join(",") || "none"}`;
	}

	return summarizeJsonPrimitive(body);
}

function summarizeJsonPrimitive(value: JsonValue): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return truncateString(value, 120);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `items=${value.length}`;
	}
	return `keys=${Object.keys(value).slice(0, 6).join(",") || "none"}`;
}

function getJsonPathValue(value: JsonValue, pathValue: string): JsonValue | undefined {
	const segments = pathValue.split(".").map((part) => part.trim()).filter(Boolean);
	let current: JsonValue | undefined = value;
	for (const segment of segments) {
		if (current === undefined || current === null) {
			return undefined;
		}
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return undefined;
			}
			current = current[index];
			continue;
		}
		if (!isJsonObject(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function mergeExternalEndpointResults(
	execution: AnalyticsExecutionResult,
	results: ExternalEndpointExecutionResult[],
): AnalyticsExecutionResult {
	const summarySection = buildExternalEndpointSummaryMarkdown(results);
	return {
		...execution,
		requestPayload: {
			...execution.requestPayload,
			externalEndpoints: results.map((result) => result.requestPayload) as JsonValue,
		},
		responsePayload: {
			...execution.responsePayload,
			externalEndpoints: Object.fromEntries(results.map((result) => [result.endpointId, result.responsePayload])) as JsonValue,
		},
		summaryMarkdown: summarySection ? `${execution.summaryMarkdown}\n\n${summarySection}` : execution.summaryMarkdown,
		externalResults: results,
	};
}

function buildExternalEndpointSummaryMarkdown(results: ExternalEndpointExecutionResult[]): string {
	if (results.length === 0) {
		return "";
	}

	return [
		"## External Endpoints",
		"",
		...results.map((result) => `- ${result.displayName}: ${result.summaryText}`),
	].join("\n");
}

function buildExternalEndpointDataPreview(responsePayload: JsonObject): string[] {
	const body = responsePayload.body;
	if (body === null || body === undefined) {
		return ["*No data returned.*"];
	}

	if (Array.isArray(body)) {
		const lines: string[] = [`items: ${body.length}`];
		for (const item of body.slice(0, 15)) {
			if (isJsonObject(item)) {
				const parts = Object.entries(item)
					.slice(0, 6)
					.map(([k, v]) => `${k}=${summarizeJsonPrimitive(v)}`);
				lines.push(`- ${parts.join(", ")}`);
			} else {
				lines.push(`- ${summarizeJsonPrimitive(item)}`);
			}
		}
		if (body.length > 15) {
			lines.push(`- ... and ${body.length - 15} more items`);
		}
		return lines;
	}

	if (isJsonObject(body)) {
		const lines: string[] = [];
		for (const [key, value] of Object.entries(body)) {
			if (lines.length >= 20) {
				lines.push(`- ... and ${Object.keys(body).length - 20} more keys`);
				break;
			}
			if (Array.isArray(value)) {
				lines.push(`- ${key}: ${value.length} items`);
				for (const item of value.slice(0, 5)) {
					if (isJsonObject(item)) {
						const parts = Object.entries(item)
							.slice(0, 6)
							.map(([k, v]) => `${k}=${summarizeJsonPrimitive(v)}`);
						lines.push(`  - ${parts.join(", ")}`);
					} else {
						lines.push(`  - ${summarizeJsonPrimitive(item)}`);
					}
				}
			} else {
				lines.push(`- ${key}: ${summarizeJsonPrimitive(value)}`);
			}
		}
		return lines.length > 0 ? lines : ["*Empty response object.*"];
	}

	return [summarizeJsonPrimitive(body)];
}

function appendExternalEndpointResultsToReply(reply: string, results: ExternalEndpointExecutionResult[]): string {
	if (results.length === 0) {
		return reply;
	}

	return [
		reply,
		"",
		"## External Endpoints",
		"",
		...results.map((result) => `- ${result.displayName}: ${result.summaryText}`),
	].join("\n");
}

async function loadExternalEndpointDefinition(endpointsDir: string, name: string): Promise<ExternalEndpointDefinition> {
	const safeName = path.basename(name).replace(/\.json$/i, "");
	const filePath = path.join(endpointsDir, `${safeName}.json`);
	const resolved = path.resolve(filePath);
	if (!resolved.startsWith(path.resolve(endpointsDir))) {
		throw new Error(`Invalid endpoint name '${name}'.`);
	}

	let content: string;
	try {
		content = await readFile(resolved, "utf8");
	} catch {
		const available = await listSavedExternalEndpoints(endpointsDir);
		const hint = available.length > 0
			? `Available endpoints: ${available.join(", ")}.`
			: `No endpoints found in ${path.relative(process.cwd(), endpointsDir)}/. Add a .json file to get started.`;
		throw new Error(`External endpoint '${safeName}' not found at ${path.relative(process.cwd(), resolved)}. ${hint}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in endpoint file '${safeName}.json'.`);
	}

	if (!isJsonObject(parsed)) {
		throw new Error(`Endpoint file '${safeName}.json' must contain a JSON object.`);
	}

	return validateExternalEndpointDefinition(safeName, parsed);
}

async function listSavedExternalEndpoints(endpointsDir: string): Promise<string[]> {
	try {
		const entries = await readdir(endpointsDir);
		return entries
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => entry.replace(/\.json$/i, ""))
			.sort();
	} catch {
		return [];
	}
}

function validateExternalEndpointDefinition(name: string, value: JsonObject): ExternalEndpointDefinition {
	if (typeof value.url !== "string" || !value.url.trim()) {
		throw new Error(`Endpoint '${name}' must define a non-empty string 'url'.`);
	}
	if (typeof value.apiKeyEnv !== "string" || !value.apiKeyEnv.trim()) {
		throw new Error(`Endpoint '${name}' must define a non-empty string 'apiKeyEnv'.`);
	}
	if (value.method !== undefined && typeof value.method !== "string") {
		throw new Error(`Endpoint '${name}' field 'method' must be a string.`);
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw new Error(`Endpoint '${name}' field 'enabled' must be a boolean.`);
	}
	if (value.name !== undefined && typeof value.name !== "string") {
		throw new Error(`Endpoint '${name}' field 'name' must be a string.`);
	}
	if (value.description !== undefined && typeof value.description !== "string") {
		throw new Error(`Endpoint '${name}' field 'description' must be a string.`);
	}
	if (value.headers !== undefined && !isJsonObject(value.headers)) {
		throw new Error(`Endpoint '${name}' field 'headers' must be a JSON object.`);
	}
	if (value.query !== undefined && !isJsonObject(value.query)) {
		throw new Error(`Endpoint '${name}' field 'query' must be a JSON object.`);
	}
	if (value.summaryFields !== undefined) {
		if (!Array.isArray(value.summaryFields) || value.summaryFields.some((item) => typeof item !== "string" || !item.trim())) {
			throw new Error(`Endpoint '${name}' field 'summaryFields' must be an array of non-empty strings.`);
		}
	}
	if (value.aiParameters !== undefined && !isJsonObject(value.aiParameters)) {
		throw new Error(`Endpoint '${name}' field 'aiParameters' must be a JSON object.`);
	}

	return {
		url: value.url.trim(),
		apiKeyEnv: value.apiKeyEnv.trim(),
		name: typeof value.name === "string" ? value.name.trim() : undefined,
		description: typeof value.description === "string" ? value.description.trim() : undefined,
		method: typeof value.method === "string" ? value.method.trim() : undefined,
		enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
		headers: isJsonObject(value.headers) ? cloneJsonObject(value.headers) : undefined,
		query: isJsonObject(value.query) ? cloneJsonObject(value.query) : undefined,
		body: value.body,
		summaryFields: Array.isArray(value.summaryFields)
			? value.summaryFields
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
			: undefined,
		aiParameters: isJsonObject(value.aiParameters) ? validateExternalEndpointAiParameters(name, value.aiParameters) : undefined,
	};
}

function validateExternalEndpointAiParameters(name: string, value: JsonObject): ExternalEndpointAiParameters {
	if (!isJsonObject(value.fields) || Object.keys(value.fields).length === 0) {
		throw new Error(`Endpoint '${name}' field 'aiParameters.fields' must be a non-empty JSON object.`);
	}

	const fields: Record<string, ExternalEndpointAiFieldSchema> = {};
	for (const [fieldName, fieldValue] of Object.entries(value.fields)) {
		if (!isJsonObject(fieldValue)) {
			throw new Error(`Endpoint '${name}' aiParameters field '${fieldName}' must be a JSON object.`);
		}
		if (fieldValue.type !== "enum") {
			throw new Error(`Endpoint '${name}' aiParameters field '${fieldName}' currently only supports type 'enum'.`);
		}
		if (!Array.isArray(fieldValue.options) || fieldValue.options.some((item) => typeof item !== "string" || !item.trim())) {
			throw new Error(`Endpoint '${name}' aiParameters field '${fieldName}' must define a non-empty string array in 'options'.`);
		}

		fields[fieldName] = {
			type: "enum",
			options: fieldValue.options
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim()),
			description: typeof fieldValue.description === "string" ? fieldValue.description.trim() : undefined,
			resolutionMode:
				fieldValue.resolutionMode === "deterministic-only"
					? "deterministic-only"
					: fieldValue.resolutionMode === "ai-only"
						? "ai-only"
						: "prefer-deterministic",
			analyticsRangeMapping: isJsonObject(fieldValue.analyticsRangeMapping)
				? validateExternalEndpointAnalyticsRangeMapping(name, fieldName, fieldValue.analyticsRangeMapping, fieldValue.options)
				: undefined,
		};
	}

	return {
		prompt: typeof value.prompt === "string" ? value.prompt.trim() : undefined,
		fields,
	};
}

function validateExternalEndpointAnalyticsRangeMapping(
	endpointName: string,
	fieldName: string,
	value: JsonObject,
	options: unknown[],
): ExternalEndpointAnalyticsRangeMapping {
	if (value.anchor !== undefined && value.anchor !== "any" && value.anchor !== "today") {
		throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.anchor must be 'any' or 'today'.`);
	}

	const optionSet = new Set(
		options
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim().toLowerCase()),
	);

	let exactDayOptions: ExternalEndpointAnalyticsRangeMapping["exactDayOptions"];
	if (value.exactDayOptions !== undefined) {
		if (!isJsonObject(value.exactDayOptions)) {
			throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.exactDayOptions must be a JSON object.`);
		}

		exactDayOptions = {};
		for (const key of ["today", "yesterday"] as const) {
			const rawValue = value.exactDayOptions[key];
			if (rawValue === undefined) {
				continue;
			}
			if (typeof rawValue !== "string" || !rawValue.trim()) {
				throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.exactDayOptions.${key} must be a non-empty string.`);
			}
			if (!optionSet.has(rawValue.trim().toLowerCase())) {
				throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.exactDayOptions.${key} must match one of the declared enum options.`);
			}
			exactDayOptions[key] = rawValue.trim();
		}
	}

	let spanDayOptions: Record<string, string> | undefined;
	if (value.spanDayOptions !== undefined) {
		if (!isJsonObject(value.spanDayOptions)) {
			throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.spanDayOptions must be a JSON object.`);
		}

		spanDayOptions = {};
		for (const [dayCount, rawOption] of Object.entries(value.spanDayOptions)) {
			if (!/^\d+$/.test(dayCount) || Number(dayCount) <= 0) {
				throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.spanDayOptions keys must be positive integer day counts.`);
			}
			if (typeof rawOption !== "string" || !rawOption.trim()) {
				throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.spanDayOptions.${dayCount} must be a non-empty string.`);
			}
			if (!optionSet.has(rawOption.trim().toLowerCase())) {
				throw new Error(`Endpoint '${endpointName}' aiParameters field '${fieldName}' analyticsRangeMapping.spanDayOptions.${dayCount} must match one of the declared enum options.`);
			}
			spanDayOptions[dayCount] = rawOption.trim();
		}
	}

	return {
		anchor: value.anchor === "today" ? "today" : "any",
		exactDayOptions,
		spanDayOptions,
	};
}

function resolveExternalEndpointMethod(method: string | undefined, body: JsonValue | undefined): string {
	const normalized = method?.trim().toUpperCase() || (body === undefined ? "GET" : "POST");
	if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) {
		throw new Error(`Unsupported external endpoint method '${normalized}'. Use GET, POST, PUT, PATCH, or DELETE.`);
	}
	return normalized;
}

function interpolateTemplateString(value: string, context: Record<string, string>): string {
	return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => context[key] ?? "");
}

function interpolateJsonValue(value: JsonValue, context: Record<string, string>): JsonValue {
	if (typeof value === "string") {
		return interpolateTemplateString(value, context);
	}
	if (Array.isArray(value)) {
		return value.map((item) => interpolateJsonValue(item, context));
	}
	if (!isJsonObject(value)) {
		return value;
	}

	const normalized: JsonObject = {};
	for (const [key, childValue] of Object.entries(value)) {
		normalized[key] = interpolateJsonValue(childValue, context);
	}
	return normalized;
}

function interpolateOptionalObject(value: JsonObject | undefined, context: Record<string, string>): JsonObject | undefined {
	if (!value) {
		return undefined;
	}
	const interpolated = interpolateJsonValue(value, context);
	if (!isJsonObject(interpolated)) {
		throw new Error("Interpolated endpoint object must remain a JSON object.");
	}
	return interpolated;
}

function normalizeInterpolatedBody(value: JsonValue): JsonValue {
	const normalized = pruneEmptyTemplateValues(value);
	if (normalized === undefined) {
		return {};
	}
	return normalized;
}

async function buildExternalEndpointBody(input: {
	definition: ExternalEndpointDefinition;
	context: Record<string, string>;
	promptText: string;
	plugin: PluginContract;
}): Promise<{
	body: JsonValue | undefined;
	parameterResolution: JsonObject | null;
}> {
	const baseBody = input.definition.body === undefined
		? undefined
		: normalizeInterpolatedBody(interpolateJsonValue(input.definition.body, input.context));

	if (!input.definition.aiParameters) {
		return {
			body: baseBody,
			parameterResolution: null,
		};
	}

	const aiResolution = await resolveExternalEndpointAiParameters({
		definition: input.definition,
		context: input.context,
		promptText: input.promptText,
		plugin: input.plugin,
	});
	const aiBodyFields = aiResolution?.values ?? null;
	if (!aiBodyFields || Object.keys(aiBodyFields).length === 0) {
		return {
			body: baseBody,
			parameterResolution: aiResolution?.debug ?? null,
		};
	}

	if (baseBody === undefined) {
		return {
			body: aiBodyFields,
			parameterResolution: aiResolution?.debug ?? null,
		};
	}
	if (!isJsonObject(baseBody)) {
		throw new Error("AI-selected endpoint parameters require the base body to be a JSON object.");
	}

	return {
		body: {
			...baseBody,
			...aiBodyFields,
		},
		parameterResolution: aiResolution?.debug ?? null,
	};
}

async function resolveExternalEndpointAiParameters(input: {
	definition: ExternalEndpointDefinition;
	context: Record<string, string>;
	promptText: string;
	plugin: PluginContract;
}): Promise<ExternalEndpointAiResolutionResult | null> {
	const promptText = input.promptText.trim();

	const aiConfig = input.definition.aiParameters;
	if (!aiConfig) {
		return null;
	}

	const deterministicResolution = resolveDeterministicExternalEndpointAiParameters({
		aiConfig,
		context: input.context,
	});
	const deterministicFields = deterministicResolution.values;
	const modelEligibleFields = Object.entries(aiConfig.fields)
		.filter(([, config]) => config.resolutionMode !== "deterministic-only")
		.filter(([fieldName, config]) => config.resolutionMode === "ai-only" || deterministicFields[fieldName] === undefined)
		.map(([name, config]) => ({
			name,
			type: config.type,
			options: config.options,
			description: config.description ?? null,
			resolutionMode: config.resolutionMode ?? "prefer-deterministic",
		}));

	if (!promptText || modelEligibleFields.length === 0) {
		return Object.keys(deterministicFields).length > 0 || Object.keys(deterministicResolution.debug).length > 0
			? {
				values: deterministicFields,
				debug: deterministicResolution.debug,
			}
			: null;
	}

	try {
		const response = await generateText({
			task: "router",
			model: getAnalyticsIntentModel(input.plugin),
			plugin: input.plugin,
			input: [
				{
					role: "system",
					content: [{
						type: "input_text",
						text: [
							"You extract endpoint parameter values from a user's analytics request.",
							"Return strict JSON only.",
							"Output format: {\"fields\": {\"fieldName\": <selected enum value or null>}, \"confidence\": {\"fieldName\": \"low|medium|high\"}, \"reasons\": {\"fieldName\": \"brief why\"}}",
							"Only choose a value when the user's request clearly implies it.",
							"If a field is not clearly requested, return null for that field.",
							"Never invent values outside the provided enum options.",
							"Use high confidence only when the request is explicit or the analytics context strongly implies the value.",
							"Keep reasons short and concrete.",
							aiConfig.prompt || "",
						].filter(Boolean).join("\n"),
					}],
				},
				{
					role: "user",
					content: [{
						type: "input_text",
						text: JSON.stringify({
							userPrompt: promptText,
							analyticsContext: {
								operationKind: input.context.operationKind || null,
								startDate: input.context.startDate || null,
								endDate: input.context.endDate || null,
								dateLabel: input.context.dateLabel || null,
								presetName: input.context.presetName || null,
								exploreName: input.context.exploreName || null,
							},
							fields: modelEligibleFields,
						}),
					}],
				},
			],
		});

		const parsedFields = parseExternalEndpointAiParameterResponse(response.text, aiConfig, modelEligibleFields.map((field) => field.name));
		if (!parsedFields) {
			return Object.keys(deterministicFields).length > 0 || Object.keys(deterministicResolution.debug).length > 0
				? {
					values: deterministicFields,
					debug: deterministicResolution.debug,
				}
				: null;
		}

		return {
			values: {
				...parsedFields.fields,
				...deterministicFields,
			},
			debug: {
				...parsedFields.debug,
				...deterministicResolution.debug,
			},
		};
	} catch {
		return Object.keys(deterministicFields).length > 0 || Object.keys(deterministicResolution.debug).length > 0
			? {
				values: deterministicFields,
				debug: deterministicResolution.debug,
			}
			: null;
	}
}

function resolveDeterministicExternalEndpointAiParameters(input: {
	aiConfig: ExternalEndpointAiParameters;
	context: Record<string, string>;
}): ExternalEndpointAiResolutionResult {
	const resolved: JsonObject = {};
	const debug: JsonObject = {};

	for (const [fieldName, fieldConfig] of Object.entries(input.aiConfig.fields)) {
		const inferredValue = inferExternalEndpointEnumFieldValue(fieldName, fieldConfig, input.context);
		if (inferredValue.value) {
			resolved[fieldName] = inferredValue.value;
			debug[fieldName] = {
				value: inferredValue.value,
				source: "deterministic",
				confidence: "high",
				resolutionMode: fieldConfig.resolutionMode ?? "prefer-deterministic",
				reason: inferredValue.reason,
			};
		}
	}

	return {
		values: resolved,
		debug,
	};
}

function inferExternalEndpointEnumFieldValue(
	fieldName: string,
	fieldConfig: ExternalEndpointAiFieldSchema,
	context: Record<string, string>,
): { value: string | null; reason: string | null } {
	if (fieldConfig.type !== "enum") {
		return { value: null, reason: null };
	}

	if (fieldConfig.analyticsRangeMapping) {
		return inferAnalyticsTimeframeOptionFromMapping(fieldConfig.analyticsRangeMapping, context);
	}

	if (/(time|date|range)/i.test(fieldName)) {
		const value = inferAnalyticsTimeframeOption(fieldConfig.options, context);
		return {
			value,
			reason: value ? "generic-timeframe-inference" : null,
		};
	}

	return { value: null, reason: null };
}

function inferAnalyticsTimeframeOption(options: string[], context: Record<string, string>): string | null {
	if (options.length === 0) {
		return null;
	}

	const optionMap = new Map(options.map((option) => [option.trim().toLowerCase(), option]));
	const exactDayOption = inferExactAnalyticsDayOption(context, optionMap);
	if (exactDayOption) {
		return exactDayOption;
	}

	const explicitRangeOption = inferExplicitAnalyticsRangeOption(context, optionMap);
	if (explicitRangeOption) {
		return explicitRangeOption;
	}

	return null;
}

function inferAnalyticsTimeframeOptionFromMapping(
	mapping: ExternalEndpointAnalyticsRangeMapping,
	context: Record<string, string>,
	): { value: string | null; reason: string | null } {
	const exactDayOption = inferMappedExactAnalyticsDayOption(mapping, context);
	if (exactDayOption.value) {
		return exactDayOption;
	}

	return inferMappedAnalyticsSpanOption(mapping, context);
}

function inferMappedExactAnalyticsDayOption(
	mapping: ExternalEndpointAnalyticsRangeMapping,
	context: Record<string, string>,
): { value: string | null; reason: string | null } {
	const startDate = parseIsoDateOnly(context.startDate);
	const endDate = parseIsoDateOnly(context.endDate);
	if (!startDate || !endDate || startDate.getTime() !== endDate.getTime()) {
		return { value: null, reason: null };
	}

	const exactDayOptions = mapping.exactDayOptions;
	if (!exactDayOptions) {
		return { value: null, reason: null };
	}

	const today = formatDate(new Date());
	if (context.endDate === today && exactDayOptions.today) {
		return { value: exactDayOptions.today, reason: "analyticsRangeMapping.exactDayOptions.today" };
	}

	const yesterdayDate = new Date();
	yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
	if (context.endDate === formatDate(yesterdayDate) && exactDayOptions.yesterday) {
		return { value: exactDayOptions.yesterday, reason: "analyticsRangeMapping.exactDayOptions.yesterday" };
	}

	return { value: null, reason: null };
}

function inferMappedAnalyticsSpanOption(
	mapping: ExternalEndpointAnalyticsRangeMapping,
	context: Record<string, string>,
): { value: string | null; reason: string | null } {
	const spanDayOptions = mapping.spanDayOptions;
	if (!spanDayOptions) {
		return { value: null, reason: null };
	}

	if (mapping.anchor === "today") {
		const today = formatDate(new Date());
		if (context.endDate !== today) {
			return { value: null, reason: null };
		}
	}

	const labelMatch = context.dateLabel.match(/^last-(\d+)-days$/i);
	if (labelMatch) {
		const mappedOption = spanDayOptions[labelMatch[1]];
		if (mappedOption) {
			return { value: mappedOption, reason: `analyticsRangeMapping.spanDayOptions.${labelMatch[1]}` };
		}
	}

	const startDate = parseIsoDateOnly(context.startDate);
	const endDate = parseIsoDateOnly(context.endDate);
	if (!startDate || !endDate) {
		return { value: null, reason: null };
	}

	const diffDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
	if (diffDays <= 0) {
		return { value: null, reason: null };
	}

	const mappedOption = spanDayOptions[String(diffDays)] ?? null;
	return {
		value: mappedOption,
		reason: mappedOption ? `analyticsRangeMapping.spanDayOptions.${diffDays}` : null,
	};
}

function inferExactAnalyticsDayOption(
	context: Record<string, string>,
	optionMap: Map<string, string>,
): string | null {
	const startDate = parseIsoDateOnly(context.startDate);
	const endDate = parseIsoDateOnly(context.endDate);
	if (!startDate || !endDate || startDate.getTime() !== endDate.getTime()) {
		return null;
	}

	const today = formatDate(new Date());
	if (context.endDate === today && optionMap.has("today")) {
		return optionMap.get("today") ?? null;
	}

	const yesterdayDate = new Date();
	yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
	if (context.endDate === formatDate(yesterdayDate) && optionMap.has("yesterday")) {
		return optionMap.get("yesterday") ?? null;
	}

	return null;
}

function inferExplicitAnalyticsRangeOption(
	context: Record<string, string>,
	optionMap: Map<string, string>,
): string | null {
	const labelMatch = context.dateLabel.match(/^last-(\d+)-days$/i);
	if (labelMatch) {
		const labelOption = optionMap.get(`${labelMatch[1]}d`);
		if (labelOption) {
			return labelOption;
		}
	}

	const startDate = parseIsoDateOnly(context.startDate);
	const endDate = parseIsoDateOnly(context.endDate);
	if (!startDate || !endDate) {
		return null;
	}

	const diffDays = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
	if (diffDays <= 0) {
		return null;
	}

	return optionMap.get(`${diffDays}d`) ?? null;
}

function parseIsoDateOnly(value: string | undefined): Date | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return null;
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseExternalEndpointAiParameterResponse(
	text: string,
	aiConfig: ExternalEndpointAiParameters,
	allowedFields?: string[],
): ParsedExternalEndpointAiResponse | null {
	const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	if (!normalized) {
		return null;
	}

	try {
		const parsed = JSON.parse(normalized) as Record<string, unknown>;
		if (!parsed.fields || typeof parsed.fields !== "object" || Array.isArray(parsed.fields)) {
			return null;
		}

		const output: JsonObject = {};
		const debug: JsonObject = {};
		const confidenceMap = parsed.confidence && typeof parsed.confidence === "object" && !Array.isArray(parsed.confidence)
			? parsed.confidence as Record<string, unknown>
			: {};
		const reasonMap = parsed.reasons && typeof parsed.reasons === "object" && !Array.isArray(parsed.reasons)
			? parsed.reasons as Record<string, unknown>
			: {};
		const allowedFieldSet = new Set((allowedFields ?? Object.keys(aiConfig.fields)).map((field) => field.trim()));
		for (const [fieldName, fieldConfig] of Object.entries(aiConfig.fields)) {
			if (!allowedFieldSet.has(fieldName)) {
				continue;
			}
			const rawValue = (parsed.fields as Record<string, unknown>)[fieldName];
			if (rawValue === null || rawValue === undefined || typeof rawValue !== "string") {
				continue;
			}

			const matchedValue = fieldConfig.options.find((option) => option.toLowerCase() === rawValue.trim().toLowerCase());
			if (matchedValue) {
				output[fieldName] = matchedValue;
				const rawConfidence = typeof confidenceMap[fieldName] === "string" ? confidenceMap[fieldName].trim().toLowerCase() : "medium";
				const confidence = rawConfidence === "high" || rawConfidence === "low" ? rawConfidence : "medium";
				debug[fieldName] = {
					value: matchedValue,
					source: "model",
					confidence,
					resolutionMode: fieldConfig.resolutionMode ?? "prefer-deterministic",
					reason: typeof reasonMap[fieldName] === "string" && reasonMap[fieldName].trim().length > 0
						? truncateString(reasonMap[fieldName].trim(), 160)
						: "model-selected",
				};
			}
		}

		return {
			fields: output,
			debug,
		};
	} catch {
		return null;
	}
}

function pruneEmptyTemplateValues(value: JsonValue): JsonValue | undefined {
	if (typeof value === "string") {
		return value.trim() === "" ? undefined : value;
	}

	if (Array.isArray(value)) {
		const normalizedItems = value
			.map((item) => pruneEmptyTemplateValues(item))
			.filter((item): item is JsonValue => item !== undefined);
		return normalizedItems;
	}

	if (!isJsonObject(value)) {
		return value;
	}

	const normalized: JsonObject = {};
	for (const [key, childValue] of Object.entries(value)) {
		const nextValue = pruneEmptyTemplateValues(childValue);
		if (nextValue !== undefined) {
			normalized[key] = nextValue;
		}
	}
	return normalized;
}

function convertObjectToStringRecord(value: JsonObject | undefined, label: string): Record<string, string> {
	if (!value) {
		return {};
	}

	const normalized: Record<string, string> = {};
	for (const [key, childValue] of Object.entries(value)) {
		if (typeof childValue === "string" || typeof childValue === "number" || typeof childValue === "boolean") {
			normalized[key] = String(childValue);
			continue;
		}
		throw new Error(`Endpoint ${label} values must be strings, numbers, or booleans. Invalid key: ${key}.`);
	}
	return normalized;
}

function truncateString(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}