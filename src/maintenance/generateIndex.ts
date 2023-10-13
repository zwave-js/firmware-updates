import path from "path-browserify";
import { generateIndex } from "../lib/config";
import { NodeFS } from "./nodeFS";

import { dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const configDir = path.join(__dirname, "../../firmwares");

void (async () => {
	console.log();
	console.log("Generating index...");
	const index = await generateIndex(NodeFS, configDir);
	await NodeFS.writeFile(
		path.join(configDir, "index.json"),
		`// This file is auto-generated. DO NOT edit it by hand if you don't know what you're doing!
${JSON.stringify(index, null, "\t")}
`
	);
	console.log("Index generated");
})();
