import test from "ava";
import supertest from "supertest";
import { build } from "./app";

test("GET `/` route", async (t) => {
	const fastify = build();

	t.teardown(() => fastify.close());

	await fastify.ready();

	const response = await supertest(fastify.server)
		.get("/")
		.expect(200)
		.expect("Content-Type", "application/json; charset=utf-8");
	t.deepEqual(response.body, { hello: "world!" });
});
