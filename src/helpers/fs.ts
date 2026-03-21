import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function readUtf8File(filePath: string): Promise<string> {
	return readFile(filePath, "utf8");
}
