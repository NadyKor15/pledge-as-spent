// Local run with real sandbox credentials: reads them from Infisical into this
// process's memory and starts `next dev` with them in its environment. Nothing
// is written to disk; .env files are not used.
//
//   npm run dev:env                  PayPal sandbox only (cached receipt readings)
//   npm run dev:env -- --live-reading  also AWS Bedrock keys, LIVE_READING=on (spends from the $5 cap)

import { spawn } from "node:child_process";
import { readVaultSecrets } from "./lib/vault";

async function main() {
  const live = process.argv.includes("--live-reading");
  const pp = await readVaultSecrets({
    project: "retailbox-general",
    environment: "prod",
    path: "/retailbox-internal-development",
    keys: ["PAYPAL_SANDBOX_NADYA_CLIENT_ID", "PAYPAL_SANDBOX_NADYA_SECRET"],
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PAYPAL_CLIENT_ID: pp.PAYPAL_SANDBOX_NADYA_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: pp.PAYPAL_SANDBOX_NADYA_SECRET,
    DATABASE_URL: process.env.DATABASE_URL ?? "pglite:.data/pglite",
    APP_BASE_URL: process.env.APP_BASE_URL ?? "http://localhost:3000",
  };
  if (live) {
    const aws = await readVaultSecrets({ project: "infra-tokens", environment: "prod", path: "/", keys: ["AWS_P3_BEDROCK_ACCESS_KEY_ID", "AWS_P3_BEDROCK_SECRET_ACCESS_KEY"] });
    Object.assign(env, {
      AWS_ACCESS_KEY_ID: aws.AWS_P3_BEDROCK_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: aws.AWS_P3_BEDROCK_SECRET_ACCESS_KEY,
      AWS_REGION: "us-east-1",
      LIVE_READING: "on",
    });
  }
  const child = spawn("npx", ["next", "dev"], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
