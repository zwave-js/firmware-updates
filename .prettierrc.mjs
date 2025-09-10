export default {
	semi: true,
	trailingComma: "all",
	singleQuote: false,
	printWidth: 80,
	useTabs: true,
	tabWidth: 4,
	endOfLine: "lf",

	plugins: ["prettier-plugin-organize-imports"],

	overrides: [
		{
			files: "packages/config/**/*.json",
			options: {
				printWidth: 120,
			},
		},
		{
			files: "*.yml",
			options: {
				useTabs: false,
				tabWidth: 2,
				singleQuote: true,
			},
		},
		{
			files: "README.md",
			options: {
				useTabs: false,
				tabWidth: 4,
			},
		},
	],
};
