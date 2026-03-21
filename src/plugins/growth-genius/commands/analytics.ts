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
const GOOGLE_ANALYTICS_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 90;

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
}

export const analyticsCommand: PluginCommand = {
	name: "analytics",
	description: "Fetch workspace analytics data for the growth-genius plugin.",
	requiredEnv: ANALYTICS_REQUIRED_ENV,
	handle: async (input) => {
		const analyticsOutputDir = path.join(input.outputDir, "analytics");
		await mkdir(analyticsOutputDir, { recursive: true });

		const propertyId = process.env.GOOGLE_ANALYTICS_PROPERTY_ID!.trim();
		const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim();
		const serviceAccountPrivateKey = normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!);
		const dateRange = parseAnalyticsDateRange(input.args);

		const accessToken = await getGoogleAccessToken({
			serviceAccountEmail,
			serviceAccountPrivateKey,
		});
		const report = await runAnalyticsReport({
			propertyId,
			accessToken,
			dateRange,
		});

		const summary = buildReportSummary(report, dateRange, propertyId);
		const requestedAt = new Date().toISOString();
		const requestArtifactPath = path.join(analyticsOutputDir, "latest-request.json");
		const reportArtifactPath = path.join(analyticsOutputDir, "latest-report.json");
		const summaryArtifactPath = path.join(analyticsOutputDir, "latest-summary.md");

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
					dateRange,
				},
				null,
				2,
			),
			"utf8",
		);
		await writeFile(reportArtifactPath, JSON.stringify(report, null, 2), "utf8");
		await writeFile(summaryArtifactPath, summary.markdown, "utf8");

		return {
			reply: [
				`/analytics routed to ${input.plugin.id}.`,
				`property=${propertyId}`,
				`range=${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
				`activeUsers=${summary.totals.activeUsers}`,
				`newUsers=${summary.totals.newUsers}`,
				`sessions=${summary.totals.sessions}`,
				`screenPageViews=${summary.totals.screenPageViews}`,
				`engagementRate=${summary.totals.engagementRate}`,
				`rows=${summary.rowCount}`,
			].join("\n"),
			outputFiles: [
				path.relative(process.cwd(), requestArtifactPath),
				path.relative(process.cwd(), reportArtifactPath),
				path.relative(process.cwd(), summaryArtifactPath),
			],
		};
	},
};

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

	throw new Error("Unsupported /analytics args. Use '/analytics', '/analytics 30d', or '/analytics 2026-03-01 2026-03-21'.");
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

async function runAnalyticsReport(input: {
	propertyId: string;
	accessToken: string;
	dateRange: AnalyticsDateRange;
}): Promise<GoogleAnalyticsReportResponse> {
	const response = await fetch(`${GOOGLE_ANALYTICS_API_BASE}/properties/${input.propertyId}:runReport`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${input.accessToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			dateRanges: [
				{
					startDate: input.dateRange.startDate,
					endDate: input.dateRange.endDate,
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
			limit: MAX_LOOKBACK_DAYS,
		}),
	});

	if (!response.ok) {
		throw new Error(`Google Analytics report request failed with ${response.status}: ${await response.text()}`);
	}

	return await response.json() as GoogleAnalyticsReportResponse;
}

function buildReportSummary(report: GoogleAnalyticsReportResponse, dateRange: AnalyticsDateRange, propertyId: string): {
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
	const markdown = [
		"# Analytics Summary",
		"",
		`- property: ${propertyId}`,
		`- range: ${dateRange.startDate}..${dateRange.endDate} (${dateRange.label})`,
		`- rows: ${rowCount}`,
		"",
		"## Totals",
		"",
		...metricNames.map((metricName) => `- ${metricName}: ${totals[metricName] ?? "0"}`),
	].join("\n");

	return {
		rowCount,
		totals,
		markdown,
	};
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