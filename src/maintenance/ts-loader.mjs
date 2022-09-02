const extensionsRegex = /\.ts$|\.tsx$/;

export async function load(url, context, defaultLoad) {
	if (extensionsRegex.test(url)) {
		const { source } = await defaultLoad(url, { format: "module" });
		return {
			format: "commonjs",
			source: source,
		};
	}
	// let Node.js handle all other URLs
	return defaultLoad(url, context, defaultLoad);
}
