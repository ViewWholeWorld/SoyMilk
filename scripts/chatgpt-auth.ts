// Run on the browser's computer, or use an SSH loopback tunnel to a NAS container.
import http from "node:http";
import { once } from "node:events";
import { guardedFetch } from "../packages/backend/src/lib/http-fetch.ts";
import {
  CHATGPT_RESOURCE, ChatGPTAuthorizationDeclinedError, chatGPTAccess, chatGPTHostId, chatGPTProfile,
  createChatGPTAuthorization, disconnectChatGPT, finishChatGPTAuthorization,
  readChatGPTClientId, readChatGPTSession, validateChatGPTCallback, withChatGPTLock,
} from "../packages/backend/src/providers/chatgpt-auth.ts";

async function login(): Promise<void> {
  await withChatGPTLock(async () => {
    const hostId = await chatGPTHostId();
    const clientId = await readChatGPTClientId();
    const port = Number(process.env.CHATGPT_LOGIN_PORT || 1455);
    const pending = createChatGPTAuthorization(hostId, port, clientId);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    let accepted = false;
    const server = http.createServer((req, res) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(400); res.end("Invalid callback"); return; }
      const callback = new URL(req.url || "/", pending.redirectUri);
      if (callback.pathname !== "/auth/callback" || accepted) { res.writeHead(404); res.end("Not found"); return; }
      try { validateChatGPTCallback(callback, pending); }
      catch (error) {
        res.writeHead(400); res.end("Authorization callback rejected. Start a new login if you declined consent.");
        if (error instanceof ChatGPTAuthorizationDeclinedError) { accepted = true; reject(error); }
        return;
      }
      accepted = true;
      void finishChatGPTAuthorization(pending, callback).then((status) => {
        res.end("SoyMilk authorization saved. You can close this tab.");
        console.log(JSON.stringify(status));
        resolve();
      }).catch(() => {
        res.writeHead(400); res.end("Authorization could not be verified. Start a new login.");
        reject(new Error("ChatGPT authorization failed; start a new login"));
      });
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const timer = setTimeout(() => reject(new Error("ChatGPT login timed out")), 10 * 60_000);
    console.log("Continue with ChatGPT: open this URL on the computer running the callback listener or SSH tunnel.");
    console.log(pending.url);
    try { await done; }
    finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }
  });
}

try {
  const command = process.argv[2] || "status";
  if (command === "login") await login();
  else if (command === "init-host") console.log(await withChatGPTLock(chatGPTHostId));
  else if (command === "status") {
    const session = await readChatGPTSession();
    console.log(JSON.stringify({ profile: chatGPTProfile(), connected: !!session?.access_token, account: session?.email || session?.subject || null, planUsage: !!session?.access_token && session.scopes.includes("chatgpt.tokens.use.direct"), expiresAt: session?.expires_at ? new Date(session.expires_at).toISOString() : null }));
  } else if (command === "models") {
    const access = await chatGPTAccess();
    const res = await guardedFetch(`${CHATGPT_RESOURCE}/models`, { headers: { authorization: `Bearer ${access.token}` }, maxRedirects: 0 });
    if (res.status !== 200) throw new Error(`ChatGPT model discovery failed (HTTP ${res.status})`);
    const data = JSON.parse(res.text()) as { models: Array<{ visibility: string; slug: string; display_name: string }> };
    console.log(JSON.stringify(data.models.filter((m) => m.visibility === "list").map((m) => ({ model: m.slug, name: m.display_name })), null, 2));
  } else if (command === "logout") { await disconnectChatGPT(); console.log("ChatGPT session revoked and cleared locally."); }
  else throw new Error("Usage: node scripts/chatgpt-auth.ts [login|status|models|logout|init-host]");
} catch (error) {
  // OAuth response bodies, authorization codes and tokens must never reach logs.
  console.error(error instanceof Error ? error.message : "ChatGPT authorization failed");
  process.exitCode = 1;
}
