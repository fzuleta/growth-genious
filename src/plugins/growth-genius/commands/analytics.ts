import { createSign } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { PluginCommand } from "../../../plugin-contract";

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
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 90;
const MAX_METADATA_PREVIEW_ITEMS = 25;
const MAX_ADMIN_PREVIEW_ITEMS = 20;

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

interface JsonObject {
	[key: string]: JsonValue;
}

type AnalyticsOperationKind = "help" | "legacy-report" | "metadata" | "admin" | "report" | "pivot" | "funnel" | "realtime" | "preset";

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
}

interface AnalyticsExecutionResult {
	reply: string;
	requestPayload: JsonObject;
	responsePayload: JsonObject;
	summaryMarkdown: string;
	legacyReportArtifact?: JsonObject;
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
	handle: async (input) => {
		const analyticsOutputDir = path.join(input.outputDir, "analytics");
		await mkdir(analyticsOutputDir, { recursive: true });

		const propertyId = process.env.GOOGLE_ANALYTICS_PROPERTY_ID!.trim();
		const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim();
		const serviceAccountPrivateKey = normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!);
		const operation = parseAnalyticsOperation(input.args);

		const accessToken = await getGoogleAccessToken({
			serviceAccountEmail,
			serviceAccountPrivateKey,
		});

		const execution = await executeAnalyticsOperation({
			propertyId,
			accessToken,
			operation,
		});

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
					command: "/analytics",
					requestedAt,
					requestedBy: {
						userId: input.message.author.id,
						username: input.message.author.username,
					},
					args: input.args,
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

		return {
			reply: execution.reply,
			outputFiles,
		};
	},
};

function parseAnalyticsOperation(args: string): AnalyticsOperationRequest {
	const trimmed = args.trim();
	if (!trimmed) {
		return {
			kind: "legacy-report",
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
}): Promise<AnalyticsExecutionResult> {
	switch (input.operation.kind) {
		case "help":
			return buildHelpExecutionResult();
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
	}
}

function buildHelpExecutionResult(): AnalyticsExecutionResult {
	const presetList = Object.entries(PRESET_REPORT_CONFIG)
		.map(([name, config]) => `- \`/analytics ${name}\` — ${config.description}`)
		.join("\n");

	const summaryMarkdown = [
		"# Analytics Command Help",
		"",
		"## Quick presets (proactive reports)",
		"",
		presetList,
		"",
		"All presets default to the last 7 days. Add a date range: `/analytics events 30d` or `/analytics pages 2026-03-01 2026-03-21`.",
		"",
		"## Preserved default report",
		"",
		"- `/analytics`",
		"- `/analytics 30d`",
		"- `/analytics 2026-03-01 2026-03-21`",
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
		"- '/analytics metadata [search]'",
		`- '/analytics admin <resource>' where <resource> is one of ${Object.keys(ADMIN_RESOURCE_CONFIG).join(", ")}`,
		"- '/analytics report {json}'",
		"- '/analytics pivot {json}'",
		"- '/analytics funnel {json}'",
		"- '/analytics realtime {json}'",
		"- '/analytics help'",
	].join("\n");
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
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