import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { CLIENT_PATH, CONFIG_DIR, GRAPH, TOKEN_PATH } from "../server/facebook.ts";

/** One-off setup for Facebook Reels publishing.
 *
 *  `pnpm facebook-auth <short-lived user token>` — trades the token for a
 *  long-lived one, fetches the Page's own token, and writes
 *  ~/.vstack/facebook-token.json. A Page token obtained from a long-lived
 *  user token does not expire, so this runs once.
 *
 *  ponytail: paste-a-token rather than an OAuth loopback like
 *  `youtube-auth`. The loopback costs a Facebook Login product and a
 *  registered redirect URI in the Meta app, and ends at the same
 *  never-expiring token.
 *
 *  Setup, first time:
 *    1. developers.facebook.com → My Apps → Create app → type "Business".
 *       Dev mode is enough while you administer both the app and the Page.
 *    2. App settings → Basic: copy App ID and App secret into
 *       ~/.vstack/facebook-client.json as { "appId": "…", "appSecret": "…" }
 *    3. Tools → Graph API Explorer → pick the app → User Token → add
 *       pages_manage_posts, pages_read_engagement, pages_show_list →
 *       Generate Access Token → copy it.
 *    4. pnpm facebook-auth <that token>
 *       Several Pages? It lists them; re-run with FB_PAGE=<id>.
 */

const shortToken = process.argv[2];
if (!shortToken) {
  console.error("vstack: usage: pnpm facebook-auth <short-lived user token>  (see scripts/facebook-auth.ts)");
  process.exit(1);
}

if (!existsSync(CLIENT_PATH)) {
  console.error(`vstack: no Meta app. Put { "appId": "…", "appSecret": "…" } at\n  ${CLIENT_PATH}`);
  process.exit(1);
}
let client: { appId?: string; appSecret?: string };
try {
  client = JSON.parse(readFileSync(CLIENT_PATH, "utf8")) as typeof client;
} catch {
  console.error(`vstack: ${CLIENT_PATH} is not valid JSON. Expected { "appId": "…", "appSecret": "…" }`);
  process.exit(1);
}
if (!client.appId || !client.appSecret) {
  console.error(`vstack: ${CLIENT_PATH} needs both appId and appSecret.`);
  process.exit(1);
}

/** A GET with credentials in the query is what these two endpoints document.
 *  Acceptable in a one-off local script; the URL is never printed. */
async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Facebook refused ${path} (${res.status}): ${text}`);
  return JSON.parse(text) as T;
}

const { access_token: longToken } = await graphGet<{ access_token: string }>("oauth/access_token", {
  grant_type: "fb_exchange_token",
  client_id: client.appId,
  client_secret: client.appSecret,
  fb_exchange_token: shortToken,
});

const { data: pages } = await graphGet<{ data: { id: string; name: string; access_token: string }[] }>(
  "me/accounts",
  { access_token: longToken, fields: "id,name,access_token" },
);

if (pages.length === 0) {
  console.error("vstack: this account manages no Pages, or the token lacks pages_show_list.");
  process.exit(1);
}

const wanted = process.env.FB_PAGE;
const page = wanted ? pages.find((p) => p.id === wanted) : pages.length === 1 ? pages[0] : undefined;
if (page === undefined) {
  console.error(
    (wanted ? `vstack: no Page ${wanted} on this account.` : "vstack: several Pages — pick one:") +
      "\n" +
      pages.map((p) => `  ${p.id}  ${p.name}`).join("\n") +
      "\nRe-run with FB_PAGE=<id> pnpm facebook-auth <token>",
  );
  process.exit(1);
}

await mkdir(CONFIG_DIR, { recursive: true });
await writeFile(
  TOKEN_PATH,
  JSON.stringify({ pageId: page.id, pageName: page.name, pageToken: page.access_token }, null, 2),
  { mode: 0o600 },
);
// writeFile's mode only applies when it creates the file; a re-run keeps the
// old file's mode, so set it explicitly.
await chmod(TOKEN_PATH, 0o600);
console.error(`vstack: saved a Page token for "${page.name}" to ${TOKEN_PATH}`);
