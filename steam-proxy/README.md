# steam-proxy

En liten Cloudflare Worker som låter en statisk webbsida visa Steam-namn och
avatar utan att API-nyckeln hamnar i sidans kod. Workern håller nyckeln som
hemlighet, anropar Steam och svarar med CORS-huvuden.

## Driftsättning

1. Skapa en **ny** nyckel på https://steamcommunity.com/dev/apikey
   (en nyckel som har synts i klartext ska inte användas).
2. Installera och logga in:
   ```sh
   npm i -g wrangler      # eller använd npx
   wrangler login
   ```
3. Ändra `ALLOWED_ORIGINS` i `wrangler.toml` till sidans adress, t.ex.
   `https://minsida.se`. Flera adresser separeras med komma.
4. Lägg in nyckeln som hemlighet och driftsätt:
   ```sh
   wrangler secret put STEAM_API_KEY
   wrangler deploy
   ```
   Du får en adress som `https://steam-proxy.<ditt-konto>.workers.dev`.

## Endpoints

| Anrop | Gör |
|---|---|
| `GET /verify?openid.*…` | Kontrollerar Steam-inloggningen hos Steam och returnerar profilen. 401 om den är falsk. |
| `GET /profile?steamid=…` | Returnerar offentligt namn och avatar för ett steamid. |

Svar:
```json
{ "steamid": "7656119…", "name": "…", "avatar": "…", "avatarMedium": "…", "avatarFull": "…", "profileUrl": "…" }
```

## På sidan

Efter "Logga in med Steam" skickar Steam tillbaka användaren med
`openid.*`-parametrar i adressen. Skicka dem vidare till Workern:

```js
const PROXY = "https://steam-proxy.<ditt-konto>.workers.dev";

async function steamLoginResult() {
  const params = new URLSearchParams(location.search);
  if (params.get("openid.mode") !== "id_res") return null;
  const res = await fetch(`${PROXY}/verify?${params}`);
  if (!res.ok) return null;          // falsk eller avbruten inloggning
  history.replaceState(null, "", location.pathname); // städa adressen
  return res.json();                 // { steamid, name, avatarFull, … }
}

steamLoginResult().then((user) => {
  if (!user) return;
  document.querySelector("#steam-name").textContent = user.name;
  document.querySelector("#steam-avatar").src = user.avatarFull;
});
```

Använd `/verify` för själva inloggningen. Om sidan bara läser steamid ur
adressen och anropar `/profile` kan vem som helst skriva in någon annans id.
