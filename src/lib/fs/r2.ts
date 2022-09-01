import type { FileSystem } from "./filesystem";

const FILE_PREFIX = "file$";

export function createR2FS(bucket: R2Bucket): FileSystem {
	const ret: FileSystem = {
		async writeFile(file, data) {
			await bucket.put(`${FILE_PREFIX}${file}`, data);
		},
		async readFile(file) {
			const obj = await bucket.get(`${FILE_PREFIX}${file}`);
			if (!obj) {
				throw new Error(`File not found in R2: ${file}`);
			}
			return obj.text();
		},
		async deleteFile(file) {
			await bucket.delete(`${FILE_PREFIX}${file}`);
		},
		async readDir(dir, recursive) {
			let truncated: boolean;
			let cursor: R2ListOptions["cursor"];
			const options: R2ListOptions = {
				prefix: `${FILE_PREFIX}${dir}/`,
			};
			if (!recursive) {
				options.delimiter = "/";
			}

			const ret: string[] = [];
			do {
				const next = await bucket.list({ ...options, cursor });
				ret.push(
					...next.objects.map((o) => o.key.slice(FILE_PREFIX.length))
				);
				truncated = next.truncated;
			} while (truncated);
			return ret;
		},
		async deleteDir(dir) {
			const filesInDir = await this.readDir(dir, true);
			await Promise.all(filesInDir.map((file) => this.deleteFile(file)));
		},
	};
	return ret;
}
