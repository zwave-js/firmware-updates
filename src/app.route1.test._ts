import test from "ava";
import supertest from "supertest";
import { build } from "./app.js";

test("GET `/` route", async (t) => {
	process.env.API_REQUIRE_KEY = "false";

	const fastify = await build();
	t.teardown(() => fastify.close());
	await fastify.ready();

	await supertest(fastify.server)
		.get("/")
		.expect(200)
		.expect("Content-Type", "text/html");
	t.pass();
});
