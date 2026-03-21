export type LogLevel = "info" | "warn" | "error";

import { safeStringify } from "./log-format";

export interface LogEvent {
	timestamp: string;
	level: LogLevel;
	message: string;
	context?: Record<string, unknown>;
}

export type LogTransport = (event: LogEvent) => void | Promise<void>;

const extraTransports: LogTransport[] = [];

export function addLogTransport(transport: LogTransport): void {
	extraTransports.push(transport);
}

export function logInfo(message: string, context?: Record<string, unknown>): void {
	log("info", message, context);
}

export function logWarn(message: string, context?: Record<string, unknown>): void {
	log("warn", message, context);
}

export function logError(message: string, context?: Record<string, unknown>): void {
	log("error", message, context);
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
	const event: LogEvent = {
		timestamp: new Date().toISOString(),
		level,
		message,
		context,
	};

	writeToConsoleSafely(event);
	dispatchToExtraTransports(event);
}

function writeToConsoleSafely(event: LogEvent): void {
	try {
		writeToConsole(event);
	} catch (consoleWriteError: unknown) {
		const message =
			consoleWriteError instanceof Error ? consoleWriteError.message : String(consoleWriteError);
		process.stderr.write(
			`[${new Date().toISOString()}] [ERROR] Failed to write log to console ${safeStringify({ message })}\n`,
		);
	}
}

function writeToConsole(event: LogEvent): void {
	const prefix = `[${event.timestamp}] [${event.level.toUpperCase()}]`;
	const contextSuffix = event.context ? ` ${safeStringify(event.context)}` : "";
	const line = `${prefix} ${event.message}${contextSuffix}`;

	if (event.level === "error") {
		console.error(line);
		return;
	}

	console.log(line);
}

function dispatchToExtraTransports(event: LogEvent): void {
	for (const transport of extraTransports) {
		Promise.resolve()
			.then(() => transport(event))
			.catch((transportError: unknown) => {
			const message =
				transportError instanceof Error ? transportError.message : String(transportError);
			console.error(
				`[${new Date().toISOString()}] [ERROR] Log transport failed ${safeStringify({
					message,
				})}`,
			);
			});
	}
}
