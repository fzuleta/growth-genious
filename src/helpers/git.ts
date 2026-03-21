import { execFile } from "node:child_process";
import path from "node:path";

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const MAX_EXEC_BUFFER = 1024 * 1024;

interface GitResult {
	stdout: string;
	stderr: string;
}

function runGit(args: string[]): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd: WORKSPACE_ROOT, maxBuffer: MAX_EXEC_BUFFER },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
					return;
				}
				resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
			},
		);
	});
}

export async function getCurrentBranch(): Promise<string> {
	const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
	return result.stdout.trim();
}

export async function createBranch(name: string): Promise<void> {
	await runGit(["checkout", "-b", name]);
}

export async function checkoutBranch(name: string): Promise<void> {
	await runGit(["checkout", name]);
}

export async function deleteBranch(name: string): Promise<void> {
	await runGit(["branch", "-D", name]);
}

export async function commitAll(message: string): Promise<string> {
	await runGit(["add", "-A"]);
	const result = await runGit(["commit", "-m", message, "--allow-empty"]);
	return result.stdout.trim();
}

export async function getDiffStat(): Promise<string> {
	const result = await runGit(["diff", "--stat", "HEAD~1"]);
	return result.stdout.trim();
}

export async function getDiffFull(): Promise<string> {
	const result = await runGit(["diff", "HEAD~1"]);
	return result.stdout.trim();
}

export async function hasUncommittedChanges(): Promise<boolean> {
	const result = await runGit(["status", "--porcelain"]);
	return result.stdout.trim().length > 0;
}

export async function getStatusPorcelain(): Promise<string> {
	const result = await runGit(["status", "--porcelain"]);
	return result.stdout.trim();
}

export async function ensureCleanWorktree(): Promise<void> {
	const status = await getStatusPorcelain();
	if (!status) {
		return;
	}

	throw new Error(
		[
			"Self-modify requires a clean git worktree.",
			"Commit, stash, or discard the following changes before starting:",
			status,
		].join("\n"),
	);
}

export async function discardAllChanges(): Promise<void> {
	await runGit(["reset", "--hard", "HEAD"]);
	await runGit(["clean", "-fd"]);
}

export function sanitizeBranchName(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

export function buildBotBranchName(slug: string): string {
	const sanitized = sanitizeBranchName(slug);
	const timestamp = Date.now();
	return `bot/${sanitized}-${timestamp}`;
}
