export type GitHubClient = ReturnType<
	typeof import("@actions/github").getOctokit
>;
export type GitHubContext = typeof import("@actions/github").context;
export type CoreModule = typeof import("@actions/core");

export interface GitHubScriptContext {
	github: GitHubClient;
	context: GitHubContext;
}

export interface GitHubScriptContextWithCore extends GitHubScriptContext {
	core: CoreModule;
}
