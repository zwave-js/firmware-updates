/** Defines which methods must be supported by a replacement filesystem */
export interface FileSystem {
	writeFile(
		file: string,
		data: string | ReadableStream | ArrayBuffer | ArrayBufferView | Blob
	): Promise<void>;
	readFile(file: string): Promise<string>;
	deleteFile(file: string): Promise<void>;

	readDir(dir: string, recursive: boolean): Promise<string[]>;
	deleteDir(dir: string): Promise<void>;

	// pathExists(path: string): Promise<boolean>;
}
