#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SERVICE_LABEL = "com.fezuone.veil.bot";
const repoRoot = path.resolve(__dirname, "..");
const distBotPath = path.join(repoRoot, "dist", "bot.js");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${SERVICE_LABEL}.plist`);
const logsDir = path.join(os.homedir(), "Library", "Logs", "veil");
const stdoutPath = path.join(logsDir, "bot.log");
const stderrPath = path.join(logsDir, "bot-error.log");
const launchctlDomain = `gui/${getCurrentUid()}`;
const launchctlService = `${launchctlDomain}/${SERVICE_LABEL}`;

async function main(): Promise<void> {
	const [command = "help"] = process.argv.slice(2);

	switch (command) {
		case "install":
			await installService();
			return;
		case "start":
			await startService();
			return;
		case "stop":
			await stopService();
			return;
		case "restart":
			await restartService();
			return;
		case "status":
			await printStatus();
			return;
		case "update":
			await updateService();
			return;
		case "uninstall":
			await uninstallService();
			return;
		case "help":
		case "--help":
		case "-h":
			printHelp();
			return;
		default:
			fail(`Unknown command: ${command}`);
	}
}

async function installService(): Promise<void> {
	ensureMacOs();
	ensureBuild();
	await mkdir(launchAgentsDir, { recursive: true });
	await mkdir(logsDir, { recursive: true });
	await writeFile(plistPath, buildLaunchAgentPlist(), "utf8");

	if (isServiceLoaded()) {
		launchctl(["bootout", launchctlService], { allowFailure: true });
	}

	launchctl(["bootstrap", launchctlDomain, plistPath], { allowFailure: false });
	launchctl(["enable", launchctlService], { allowFailure: false });
	launchctl(["kickstart", "-k", launchctlService], { allowFailure: false });

	console.log(`Installed ${SERVICE_LABEL}`);
	console.log(`LaunchAgent: ${plistPath}`);
	console.log(`Stdout log: ${stdoutPath}`);
	console.log(`Stderr log: ${stderrPath}`);
}

async function startService(): Promise<void> {
	ensureMacOs();
	ensureBuild();
	ensureInstalled();

	if (!isServiceLoaded()) {
		launchctl(["bootstrap", launchctlDomain, plistPath], { allowFailure: false });
	}

	launchctl(["enable", launchctlService], { allowFailure: false });
	launchctl(["kickstart", "-k", launchctlService], { allowFailure: false });
	console.log(`Started ${SERVICE_LABEL}`);
}

async function stopService(): Promise<void> {
	ensureMacOs();
	ensureInstalled();

	if (!isServiceLoaded()) {
		console.log(`${SERVICE_LABEL} is already stopped`);
		return;
	}

	const pid = getServicePid();
	launchctl(["bootout", launchctlService], { allowFailure: false });
	await waitForProcessExit(pid);
	console.log(`Stopped ${SERVICE_LABEL}`);
}

async function restartService(): Promise<void> {
	ensureMacOs();
	ensureBuild();
	ensureInstalled();

	if (isServiceLoaded()) {
		launchctl(["bootout", launchctlService], { allowFailure: false });
	}

	launchctl(["bootstrap", launchctlDomain, plistPath], { allowFailure: false });
	launchctl(["enable", launchctlService], { allowFailure: false });
	launchctl(["kickstart", "-k", launchctlService], { allowFailure: false });
	console.log(`Restarted ${SERVICE_LABEL}`);
}

async function printStatus(): Promise<void> {
	ensureMacOs();
	const installed = existsSync(plistPath);
	const loaded = installed && isServiceLoaded();

	console.log(`label: ${SERVICE_LABEL}`);
	console.log(`installed: ${installed ? "yes" : "no"}`);
	console.log(`loaded: ${loaded ? "yes" : "no"}`);

	if (!installed) {
		console.log("hint: run 'veil install'");
		return;
	}

	if (!loaded) {
		console.log(`plist: ${plistPath}`);
		return;
	}

	const result = launchctl(["print", launchctlService], { allowFailure: false, captureOutput: true });
	const summaryLines = result.stdout
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed.startsWith("pid =") ||
				trimmed.startsWith("state =") ||
				trimmed.startsWith("last exit code =") ||
				trimmed.startsWith("path =") ||
				trimmed.startsWith("program =")
			);
		});

	for (const line of summaryLines) {
		console.log(line.trim());
	}

	if (summaryLines.length === 0) {
		console.log(result.stdout.trim());
	}
	console.log(`stdout log: ${stdoutPath}`);
	console.log(`stderr log: ${stderrPath}`);
	console.log(`plist: ${plistPath}`);
}

async function updateService(): Promise<void> {
	runCommand("npm", ["install"], "Failed to install dependencies");
	runCommand("npm", ["run", "build"], "Failed to build project");

	if (existsSync(plistPath)) {
		await restartService();
		console.log("Project updated and service restarted");
		return;
	}

	console.log("Project updated");
	console.log("Service is not installed yet. Run 'veil install' when ready.");
}

async function uninstallService(): Promise<void> {
	ensureMacOs();

	if (existsSync(plistPath) && isServiceLoaded()) {
		const pid = getServicePid();
		launchctl(["bootout", launchctlService], { allowFailure: true });
		await waitForProcessExit(pid);
	}

	if (existsSync(plistPath)) {
		await rm(plistPath, { force: true });
		console.log(`Removed ${plistPath}`);
		return;
	}

	console.log(`${SERVICE_LABEL} is not installed`);
}

function printHelp(): void {
	console.log(`veil <command>

Commands:
  install    Install and start the macOS LaunchAgent
  start      Start the installed service
  stop       Stop the running service
  restart    Restart the running service
  status     Show service status
  update     Run npm install, rebuild, and restart if installed
  uninstall  Stop and remove the LaunchAgent
`);
}

function ensureMacOs(): void {
	if (process.platform !== "darwin") {
		fail("veil service management currently supports macOS only");
	}
}

function ensureBuild(): void {
	if (existsSync(distBotPath)) {
		return;
	}

	console.log("Build output not found. Running npm run build...");
	runCommand("npm", ["run", "build"], "Failed to build project");

	if (!existsSync(distBotPath)) {
		fail(`Expected compiled bot entrypoint at ${distBotPath}`);
	}
}

function ensureInstalled(): void {
	if (!existsSync(plistPath)) {
		fail(`Service is not installed. Run 'veil install' first.`);
	}
}

function isServiceLoaded(): boolean {
	const result = spawnSync("launchctl", ["print", launchctlService], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	return result.status === 0;
}

function getServicePid(): number | null {
	const result = spawnSync("launchctl", ["print", launchctlService], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.status !== 0) {
		return null;
	}

	const match = result.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
	return match ? Number(match[1]) : null;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const PROCESS_EXIT_POLL_MS = 200;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;

async function waitForProcessExit(pid: number | null): Promise<void> {
	if (pid === null || !isProcessAlive(pid)) {
		return;
	}

	const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
	}

	console.log(`Process ${pid} still alive after ${PROCESS_EXIT_TIMEOUT_MS / 1000}s, sending SIGKILL`);
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Process may have exited between the check and the kill
	}
}

function launchctl(
	args: string[],
	options: { allowFailure: boolean; captureOutput?: boolean },
): { stdout: string; stderr: string } {
	const result = spawnSync("launchctl", args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0 && !options.allowFailure) {
		fail(result.stderr?.trim() || `launchctl ${args.join(" ")} failed`);
	}

	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function runCommand(command: string, args: string[], errorMessage: string): void {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "inherit",
	});

	if (result.status !== 0) {
		fail(errorMessage);
	}
}

function buildLaunchAgentPlist(): string {
	const environmentVariables = {
		PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: os.homedir(),
	};

	const environmentXml = Object.entries(environmentVariables)
		.map(
			([key, value]) =>
				`\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`,
		)
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(process.execPath)}</string>
		<string>${escapeXml(distBotPath)}</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${escapeXml(repoRoot)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${escapeXml(stdoutPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(stderrPath)}</string>
	<key>EnvironmentVariables</key>
	<dict>
${environmentXml}
	</dict>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	fail(message);
});

function getCurrentUid(): number {
	if (typeof process.getuid !== "function") {
		fail("Unable to resolve the current macOS user id");
	}

	return process.getuid();
}