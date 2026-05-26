import test from "ava";
import { Unstable_DevWorker, unstable_dev } from "wrangler";

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
	// Get the worker instance
	const worker = (t.context as any).worker as Unstable_DevWorker;
	// Dispatch a fetch event to our worker
	const res = await worker.fetch("/");

	t.is(res.status, 200);
	t.is(res.headers.get("content-type"), "text/html");
});
