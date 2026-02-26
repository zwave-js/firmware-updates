export default {
	extensions: {
		ts: "module",
	},
	nodeArguments: ["--no-warnings", "--experimental-vm-modules"],
	files: ["src/**/*.test.ts", "test/**/*.ts"],
};
