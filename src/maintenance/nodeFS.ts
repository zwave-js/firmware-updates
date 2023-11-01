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
		const ret: string[] = [];
		if (recursive) {
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
		} else {
			ret.push(...(await fs.readdir(dir)));
		}

		// Normalize the path separator to "/", so path-browserify can handle the paths
		if (path.sep !== "/") {
			return ret.map((p) => p.replaceAll(path.sep, "/"));
		} else {
			return ret;
		}
	},
	deleteDir: function (dir: string): Promise<void> {
		return fs.rm(dir, { recursive: true, force: true });
	},
};
