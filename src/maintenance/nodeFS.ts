import fs from "node:fs/promises";
import path from "node:path";
import type { FileSystem } from "../lib/fs/filesystem";
import { getErrorMessage } from "../lib/shared";

export const NodeFS: FileSystem = {
	writeFile: function (file: string, data: string): Promise<void> {
		return fs.writeFile(file, data, "utf8");
	},
	readFile: function (file: string): Promise<string> {
		return fs.readFile(file, "utf8");
	},
	// deleteFile: function (file: string): Promise<void> {
	// 	return fs.unlink(file);
	// },
	async readDir(dir, recursive) {
		if (recursive) {
			const ret: string[] = [];
			try {
				const filesAndDirs = await fs.readdir(dir);
				for (const f of filesAndDirs) {
					const fullPath = path.join(dir, f);

					if ((await fs.stat(fullPath)).isDirectory()) {
						ret.push(...(await NodeFS.readDir(fullPath, true)));
					} else {
						ret.push(fullPath);
					}
				}
			} catch (e) {
				console.error(
					`Cannot read directory: "${dir}": ${getErrorMessage(
						e,
						true
					)}`
				);
			}

			return ret;
		} else {
			return fs.readdir(dir);
		}
	},
	deleteDir: function (dir: string): Promise<void> {
		return fs.rm(dir, { recursive: true, force: true });
	},
};
