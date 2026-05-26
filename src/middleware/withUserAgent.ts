import { error } from "itty-router";
import type { CloudflareEnvironment } from "../worker.js";

export async function withUserAgent(
	req: Request,
	_env: CloudflareEnvironment,
	_context: ExecutionContext,
): Promise<Response | undefined> {
	const userAgent = req.headers.get("user-agent");
	if (!userAgent || !userAgent.trim()) {
		return error(400, { error: "User-Agent header is required" });
	}

	(req as any).userAgent = userAgent;
}

export type UserAgentProps = { userAgent: string };
