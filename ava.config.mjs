export default {
	extensions: {
		ts: "module",
	},
	nodeArguments: [
		"--no-warnings",
		"--experimental-loader",
		"./src/maintenance/ts-loader.mjs",
		"-r",
		"esbuild-register",
		"--experimental-specifier-resolution=node",
		"--experimental-vm-modules",
	],
	files: ["src/**/*.test.ts", "test/**/*.ts"],
};
