import { build } from "./app";

async function start() {
	let port = parseInt(process.env.PORT!);
	if (isNaN(port)) port = 3000;

	const server = build({
		logger: {
			level: "info",
		},
	});

	try {
		await server.listen({ host: "::", port });
	} catch (err) {
		server.log.error(err);
		process.exit(1);
	}
}
void start();
