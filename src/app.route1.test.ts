import test from "ava";
import { UnstableDevWorker, unstable_dev } from "wrangler";

test.before(async (t) => {
	const worker = await unstable_dev("src/worker.ts", {
		experimental: { disableExperimentalWarning: true },
	});
	t.context = { worker };
});

test.after.always(async (t) => {
	const { worker } = t.context as any;
	await worker.stop();
});

test("GET `/` route", async (t) => {
	process.env.API_REQUIRE_KEY = "false";

	// Get the worker instance
	const worker = (t.context as any).worker as UnstableDevWorker;
	// Dispatch a fetch event to our worker
	const res = await worker.fetch("/");

	t.is(res.status, 200);
	t.is(res.headers.get("content-type"), "text/html");
});
