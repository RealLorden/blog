// Cloudflare Worker: Steam-proxy för en statisk webbsida.
//
// Nyckeln ligger som hemlighet (STEAM_API_KEY) i Workern och skickas aldrig
// till webbläsaren. Sidan anropar Workern, som anropar Steam och svarar med
// CORS-huvuden så att webbläsaren tillåter svaret.
//
// Endpoints:
//   GET /verify?<openid.*-parametrar från Steams inloggningsretur>
//       Verifierar Steam OpenID-inloggningen hos Steam och returnerar profilen.
//       Använd denna efter "Logga in med Steam" så att ingen kan låtsas vara
//       någon annan genom att bara ändra steamid i adressen.
//   GET /profile?steamid=7656119xxxxxxxxxx
//       Returnerar offentligt namn och avatar för ett steamid (ingen inloggning).
//
// Svar: { steamid, name, avatar, avatarMedium, avatarFull, profileUrl }

const STEAMID_RE = /^7656119\d{10}$/;
const OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const corsOrigin = allowed.includes("*")
      ? "*"
      : allowed.includes(origin)
        ? origin
        : null;

    const cors = {
      ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...cors, ...extra },
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    if (origin && !corsOrigin) {
      return json({ error: "origin_not_allowed" }, 403);
    }
    if (!env.STEAM_API_KEY) {
      return json({ error: "server_not_configured" }, 500);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/profile") {
        const steamid = url.searchParams.get("steamid") || "";
        if (!STEAMID_RE.test(steamid)) {
          return json({ error: "invalid_steamid" }, 400);
        }
        const profile = await getProfile(steamid, env, ctx);
        return profile
          ? json(profile, 200, { "Cache-Control": "public, max-age=300" })
          : json({ error: "not_found" }, 404);
      }

      if (url.pathname === "/verify") {
        const steamid = await verifyOpenId(url.searchParams);
        if (!steamid) return json({ error: "openid_invalid" }, 401);
        const profile = await getProfile(steamid, env, ctx);
        return json(profile || { steamid }, 200, { "Cache-Control": "no-store" });
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "upstream_error" }, 502);
    }
  },
};

// Frågar Steam om inloggningssvaret är äkta (check_authentication).
async function verifyOpenId(params) {
  if (params.get("openid.mode") !== "id_res") return null;
  if (params.get("openid.op_endpoint") !== OPENID_ENDPOINT) return null;

  const claimed = params.get("openid.claimed_id") || "";
  const m = claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/);
  if (!m) return null;

  const body = new URLSearchParams();
  for (const [k, v] of params) {
    if (k.startsWith("openid.")) body.set(k, v);
  }
  body.set("openid.mode", "check_authentication");

  const res = await fetch(OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return /is_valid\s*:\s*true/.test(text) ? m[1] : null;
}

// Hämtar namn och avatar, med kort cache i Cloudflares edge-cache.
async function getProfile(steamid, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://steam-proxy.cache/profile/${steamid}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const api = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
  api.searchParams.set("key", env.STEAM_API_KEY);
  api.searchParams.set("steamids", steamid);

  const res = await fetch(api);
  if (!res.ok) throw new Error(`steam ${res.status}`);
  const data = await res.json();
  const p = data?.response?.players?.[0];
  if (!p) return null;

  const profile = {
    steamid: p.steamid,
    name: p.personaname,
    avatar: p.avatar,
    avatarMedium: p.avatarmedium,
    avatarFull: p.avatarfull,
    profileUrl: p.profileurl,
  };

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(profile), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" },
      }),
    ),
  );
  return profile;
}
