import test from "ava";
import supertest from "supertest";
import { build } from "./app";

test("GET `/` route", async (t) => {
	const fastify = build();
	t.teardown(() => fastify.close());
	await fastify.ready();

	await supertest(fastify.server)
		.get("/")
		.expect(200)
		.expect("Content-Type", "text/html");
	t.pass();
});
