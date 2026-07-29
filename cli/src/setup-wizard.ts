import { confirm, input } from "@inquirer/prompts";
import { shellExec } from "./exec.js";
import { runJoin } from "./join.js";
import { loadRelaySecretFromHeroku, runDeploy } from "./ops.js";

// Owner-side end-to-end wizard: check Heroku CLI, pick / confirm an app,
// deploy, mint a bootstrap invite, then hand off to the standard join
// wizard so the owner's own machine gets configured in the same flow.
export async function runSetup(argv: string[]): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);
  if (!interactive) {
    throw new Error("doucopy setup requires an interactive terminal");
  }
  console.log("== doucopy setup ==");
  console.log("This wizard deploys the relay to Heroku, then configures this machine as the first peer.");

  await ensureHerokuCli();
  const app = await input({
    message: "Heroku app name (must be globally unique):",
    validate: (v) => (/^[a-z][a-z0-9-]{2,29}$/.test(v.trim()) ? true : "3-30 chars, lowercase letters/digits/dashes, must start with a letter"),
  });

  const proceed = await confirm({ message: `Deploy the relay to ${app} now?`, default: true });
  if (!proceed) {
    console.log("aborted");
    return;
  }

  const deployed = await runDeploy({ app, exec: shellExec });
  console.log(`relay is up at ${deployed.webUrl}`);

  const secret = await loadRelaySecretFromHeroku(app, shellExec);
  const { createTokenService } = await import("../../relay/dist/auth.js");
  const { invite, expires_at } = createTokenService(secret).issueInvite(24);
  console.log(`bootstrap invite (valid until ${new Date(expires_at).toISOString()}):`);
  console.log(`  ${invite}`);

  const continueJoin = await confirm({
    message: "Configure this machine as the first peer now (recommended)?",
    default: true,
  });
  if (!continueJoin) {
    console.log("save the invite. Later run: doucopy join <relay-url> <invite>");
    return;
  }
  await runJoin([deployed.webUrl, invite, ...argv]);
}

async function ensureHerokuCli(): Promise<void> {
  const res = await shellExec("heroku", ["--version"]);
  if (res.code !== 0) {
    console.error("Heroku CLI not found. Install: https://devcenter.heroku.com/articles/heroku-cli");
    throw new Error("heroku CLI missing");
  }
  const who = await shellExec("heroku", ["whoami"]);
  if (who.code !== 0) {
    console.error('Not logged in to Heroku. Run "heroku login" first, then re-run this wizard.');
    throw new Error("heroku not authenticated");
  }
  console.log(`heroku: logged in as ${who.stdout.trim()}`);
}
