import { execFileSync } from "node:child_process";

// Reads named secrets from Infisical at runtime. Values stay in memory only:
// never printed, never written to disk.

const VAULT = "https://vault.getaim.ai/api";

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`Infisical ${what}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function readVaultSecrets(o: { project: string; environment: string; path: string; keys: string[] }): Promise<Record<string, string>> {
  const ident = JSON.parse(execFileSync("security", ["find-generic-password", "-s", "infisical-cc-admin-ops", "-w"], { encoding: "utf8" })) as {
    clientId: string;
    clientSecret: string;
  };
  const login = await json(
    await fetch(`${VAULT}/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: ident.clientId, clientSecret: ident.clientSecret }),
    }),
    "login",
  );
  const auth = { Authorization: `Bearer ${String(login.accessToken)}` };
  const ws = (await json(await fetch(`${VAULT}/v1/workspace`, { headers: auth }), "workspaces")).workspaces as { id: string; name?: string; slug?: string }[];
  const match = ws.filter((w) => w.slug === o.project || w.name === o.project);
  if (match.length !== 1) throw new Error(`Infisical project ${o.project}: ${match.length} matches`);
  const q = new URLSearchParams({ workspaceId: match[0].id, environment: o.environment, secretPath: o.path });
  const secrets = (await json(await fetch(`${VAULT}/v3/secrets/raw?${q}`, { headers: auth }), "secrets")).secrets as { secretKey: string; secretValue: string }[];
  const out: Record<string, string> = {};
  for (const key of o.keys) {
    const v = secrets.find((s) => s.secretKey === key)?.secretValue;
    if (!v) throw new Error(`Infisical ${o.project}:${o.path} has no ${key} (present: ${secrets.map((s) => s.secretKey).join(", ")})`);
    out[key] = v;
  }
  return out;
}
