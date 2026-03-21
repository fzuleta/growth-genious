import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function createModelOutputDir(modelId: string, now = new Date()): Promise<string> {
	const outputDir = path.resolve(
		process.cwd(),
		"output",
		modelId,
		`${formatDateYyyyMmDd(now)}-${createThreeDigitSuffix()}`,
	);

	await mkdir(outputDir, { recursive: true });

	return outputDir;
}

function formatDateYyyyMmDd(date: Date): string {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function createThreeDigitSuffix(): string {
	return String(Math.floor(Math.random() * 1000)).padStart(3, "0");
}
