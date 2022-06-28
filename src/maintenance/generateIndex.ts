import fs from "fs/promises";
import path from "path";
import { configDir, generateIndex } from "../lib/config";

void (async () => {
	console.log();
	console.log("Generating index...");
	const index = await generateIndex();
	await fs.writeFile(
		path.join(configDir, "index.json"),
		`// This file is auto-generated. DO NOT edit it by hand if you don't know what you're doing!
${JSON.stringify(index, null, "\t")}
`,
		"utf8",
	);
	console.log("Index generated");
})();
