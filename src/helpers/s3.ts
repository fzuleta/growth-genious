import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { logInfo } from "./log";

export async function uploadOutputDirToS3(input: {
	modelId: string;
	outputDir: string;
}): Promise<void> {
	const {
		AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY,
		AWS_REGION,
		AWS_ENDPOINT_URL,
		AWS_BUCKET,
		DO_SPACES_BUCKET,
	} = process.env;

	if (
		!AWS_ACCESS_KEY_ID ||
		!AWS_SECRET_ACCESS_KEY ||
		!AWS_REGION ||
		!AWS_ENDPOINT_URL
	) {
		throw new Error(
			"Missing AWS upload env vars. Expected AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and AWS_ENDPOINT_URL.",
		);
	}

	const bucket = AWS_BUCKET ?? DO_SPACES_BUCKET;
	if (!bucket) {
		throw new Error("Missing bucket env var. Expected AWS_BUCKET or DO_SPACES_BUCKET.");
	}

	const s3Client = new S3Client({
		region: AWS_REGION,
		endpoint: AWS_ENDPOINT_URL,
		credentials: {
			accessKeyId: AWS_ACCESS_KEY_ID,
			secretAccessKey: AWS_SECRET_ACCESS_KEY,
		},
	});
	const outputBaseDir = path.resolve(process.cwd(), "output");
	const files = await listFilesRecursive(input.outputDir);
	logInfo("S3 upload started", {
		modelId: input.modelId,
		bucket,
		fileCount: files.length,
	});

	await Promise.all(
		files.map(async (filePath) => {
			const relativeKey = path.relative(outputBaseDir, filePath).split(path.sep).join("/");
			const body = await readFile(filePath);

			await s3Client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: relativeKey,
					Body: body,
					ACL: "public-read",
					ContentType: getContentType(filePath),
				}),
			);
		}),
	);

	logInfo("S3 upload completed", {
		modelId: input.modelId,
		bucket,
		fileCount: files.length,
		prefix: `${input.modelId}/`,
	});
}

async function listFilesRecursive(directoryPath: string): Promise<string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const nestedPaths = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				return listFilesRecursive(entryPath);
			}

			return [entryPath];
		}),
	);

	return nestedPaths.flat();
}

function getContentType(filePath: string): string | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".json":
			return "application/json";
		case ".txt":
		case ".md":
			return "text/plain; charset=utf-8";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".mp3":
			return "audio/mpeg";
		case ".wav":
			return "audio/wav";
		case ".mp4":
			return "video/mp4";
		default:
			return undefined;
	}
}
