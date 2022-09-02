import test from "ava";
import { Miniflare } from "miniflare";

test.beforeEach((t) => {
	// Create a new Miniflare environment for each test
	const mf = new Miniflare({
		// Autoload configuration from `.env`, `package.json` and `wrangler.toml`
		envPath: true,
		packagePath: true,
		wranglerConfigPath: true,
		// We don't want to rebuild our worker for each test, we're already doing
		// it once before we run all tests in package.json, so disable it here.
		// This will override the option in wrangler.toml.
		buildCommand: undefined,
	});
	t.context = { mf };
});

test("GET `/` route", async (t) => {
	process.env.API_REQUIRE_KEY = "false";

	// Get the Miniflare instance
	const mf = (t.context as any).mf as Miniflare;
	// Dispatch a fetch event to our worker
	const res = await mf.dispatchFetch("http://localhost:8787/");

	t.is(res.status, 200);
	t.is(res.headers.get("content-type"), "text/html");
});
