import dotenv from "dotenv";
import { runGenerationJob, parseCliArgs } from "./generation-service";
import { logError, logInfo, logWarn } from "./helpers/log";
import { safeStringify } from "./helpers/log-format";
import {
	configureLogTransportsFromEnv,
	publishBufferedDiscordLogs,
} from "./helpers/log-transports";

dotenv.config();
const transportConfig = configureLogTransportsFromEnv();

async function main(): Promise<void> {
	try {
		if (transportConfig.discordEnabled) {
			logInfo("Discord log transport enabled");
		} else {
			logWarn("Discord log transport disabled", {
				reason: transportConfig.reason,
			});
		}

		logInfo("Social media generation started");

		const cliArgs = parseCliArgs(process.argv.slice(2));
		logInfo("Parsed CLI args", { cliArgs });

		await runGenerationJob(cliArgs);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logError("Social media generation failed", {
			message,
			error: error instanceof Error ? { name: error.name, stack: error.stack } : error,
		});
		process.exitCode = 1;
	} finally {
		try {
			await publishBufferedDiscordLogs();
		} catch (discordPublishError: unknown) {
			const message =
				discordPublishError instanceof Error
					? discordPublishError.message
					: String(discordPublishError);
			console.error(
				`[${new Date().toISOString()}] [ERROR] Failed to publish buffered Discord logs ${safeStringify({ message })}`,
			);
		}
	}
}

main();
