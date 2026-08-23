import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  AUTH_HINT,
  CLIENT_PATH,
  CONFIG_DIR,
  SCOPE,
  TOKEN_PATH,
  exchangeCode,
  readClient,
} from "../server/youtube.ts";

/** One-off OAuth setup for publishing.
 *
 *  `pnpm youtube-auth` — opens Google's consent screen, catches the redirect
 *  on a throwaway loopback server, and writes ~/.vstack/youtube-token.json.
 *
 *  ponytail: a script, not a route. Auth happens once, and doing it in the
 *  app would cost index.ts a GET handler, a callback HTML page and a poll
 *  loop asking whether the user has finished in the other tab — all for a
 *  thing you run when you set the tool up. `scripts/audition.ts` made the
 *  same call about choosing a voice.
 *
 *  Setup, first time:
 *    1. console.cloud.google.com → a project → enable "YouTube Data API v3"
 *    2. OAuth consent screen → External → add yourself as a test user
 *       → set publishing status to "In production". Testing status expires
 *       refresh tokens after 7 days; production does not, and this scope
 *       needs no verification either way.
 *    3. Credentials → Create credentials → OAuth client ID → *Desktop app*
 *       (Google ignores the loopback port for that type, so PORT below needs
 *       no registration; a Web client would demand an exact match)
 *    4. Download the JSON to ~/.vstack/youtube-client.json
 *    5. pnpm youtube-auth
 */

const PORT = 8788;
const REDIRECT = `http://127.0.0.1:${PORT}`;

const client = readClient();
if (client === null) {
  console.error(
    `vstack: no OAuth client. Put the JSON Google Cloud Console gives you at\n` +
      `  ${CLIENT_PATH}\n` +
      `or set VSTACK_YT_CLIENT_ID and VSTACK_YT_CLIENT_SECRET.\n` +
      `See the header of scripts/youtube-auth.ts for the console steps.`,
  );
  process.exit(1);
}

// Guards the callback: only a redirect carrying the value this process
// generated is this process's redirect.
const state = randomUUID();
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    // Without this, Google returns an access token and no refresh token, and
    // publishing would need a browser round-trip every hour.
    access_type: "offline",
    // Without this, a re-run after the 7-day Testing-status expiry gets the
    // old grant back with no refresh_token attached.
    prompt: "consent",
    state,
  }).toString();

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT);
    const got = url.searchParams.get("code");
    const failed = url.searchParams.get("error");
    const ok = got !== null && url.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    // Deliberately a fixed string, never the `error` query parameter: this
    // body is served as text/html, and echoing an attacker-supplied value
    // into it is reflected XSS. The real reason is on the terminal, via the
    // rejected Error below.
    res.end(
      `<!doctype html><meta charset="utf-8"><p style="font:16px system-ui">${
        ok ? "Authorised — close this tab." : "Authorisation failed — see the terminal."
      }</p>`,
    );
    server.close();
    if (ok && got !== null) resolve(got);
    else if (got !== null) reject(new Error("OAuth state mismatch — ignoring this callback."));
    else reject(new Error(failed ?? "No code in the callback."));
  });
  server.on("error", reject);
  // Loopback only, like the main server: nothing on the LAN has any business
  // completing this handshake.
  server.listen(PORT, "127.0.0.1", () => {
    console.warn(`vstack: opening Google's consent screen…\n\n${authUrl}\n`);
    execFile("open", [authUrl], (err) => {
      if (err) console.warn("vstack: could not open a browser — paste the URL above.");
    });
  });
});

const refreshToken = await exchangeCode(client, code, REDIRECT);
// 0700 on the directory as well: the token inside is a bearer credential for
// uploading to the account's YouTube channel.
await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
await writeFile(TOKEN_PATH, `${JSON.stringify({ refresh_token: refreshToken }, null, 2)}\n`, {
  mode: 0o600,
});
// mkdir's `mode` is ignored when the directory already exists, and writeFile's
// is ignored when the file does — so both are set again explicitly.
await chmod(CONFIG_DIR, 0o700);
await chmod(TOKEN_PATH, 0o600);
console.warn(`vstack: wrote ${TOKEN_PATH}. Publishing is ready.`);
console.warn(`vstack: if uploads start failing with "${AUTH_HINT}", run this again.`);
