# Moving Pando to gitpando.com

The ruling (decisions/RULINGS.md, "The domain is gitpando.com"): gitpando.com
is the landing page, app.gitpando.com the app and API, docs.gitpando.com the
docs. This is the order for pando-ops, what the owner does, how to check each
step, and how to go back. Nothing here has been deployed yet (branch `domain`).

## What serves what

| Address | Worker | Source | How the address is attached |
| --- | --- | --- | --- |
| gitpando.com | `pando-landing` (new) | `site/landing` | `routes` in `site/landing/wrangler.jsonc` (`custom_domain: true`) |
| app.gitpando.com | `pando-dev` | `worker/` | `wrangler deploy --domain app.gitpando.com` (see below) |
| docs.gitpando.com | `pando-docs` | `site/docs` | `routes` in `site/docs/wrangler.jsonc` (`custom_domain: true`) |

All three keep `workers_dev: true`, so pando-dev.plannotator.workers.dev and
pando-docs.plannotator.workers.dev keep answering through the switch and after.

**Why app.gitpando.com is not in `worker/wrangler.jsonc`.** With a route in
that file, `wrangler dev` takes the route's host as the origin and rewrites
every request's URL to `http://app.gitpando.com/...` (checked on wrangler
4.149: the install script served by a local server named app.gitpando.com).
Clone URLs, the browser's same-origin check and every suite that reads them
would break in every lane, and each lane would need a new `wrangler dev`
flag. So the main Worker gets its custom domain at deploy instead:
`wrangler deploy --domain app.gitpando.com`. Wrangler publishes custom
domains only when some are given, so a later deploy without `--domain`
leaves app.gitpando.com in place. The docs and landing Workers are assets
only, with no code reading the URL, so their routes stay in their files.

## What `wrangler deploy` creates

From Cloudflare's docs (Workers, Routing, Custom Domains, read 2026-10-12):

- a DNS record on the gitpando.com zone for the hostname, pointing at the
  Worker (proxied; Cloudflare manages it, and it shows in the zone's DNS list);
- an edge certificate for the hostname. Issuing it can take a few minutes;
  until then HTTPS to that name fails.

What it needs:

- the gitpando.com zone active **on the same account** that wrangler deploys
  to (ee6997c7d9bdfb52ef0ceeaff6f2fa5f). A custom domain can't be made on a
  zone the account does not own;
- no existing CNAME or other record on that hostname. Today (`dig`, 2026-10-12)
  gitpando.com, app.gitpando.com and docs.gitpando.com have no records;
- wrangler's login with Workers routes write and zone read (the current login
  has both: `workers_routes (write)`, `zone (read)`, `ssl_certs (write)`).

**Is the zone on this account?** What could be checked without a token:
`npx wrangler whoami` shows one account, "Mdramos8@gmail.com's Account",
ee6997c7d9bdfb52ef0ceeaff6f2fa5f. gitpando.com's registrar is Cloudflare
(RDAP: registered 2026-10-12 10:47 UTC) and its nameservers are
anton.ns.cloudflare.com and nelly.ns.cloudflare.com, the same pair as
plannotator.ai. Cloudflare usually gives one account the same nameserver pair
for all its zones, so this points to the same account, but it is not proof.
Wrangler has no read-only command that lists zones. The owner can confirm in
the dashboard (Account home, Domains: gitpando.com listed as Active), or step
1 below confirms it: a deploy to a zone not on the account fails with a
message naming the zone, and changes nothing else.

## Before the cutover (owner)

1. **WorkOS** (dashboard, environment "Pando", Redirects), add, keeping the
   pando-dev ones:
   - Redirect URI: `https://app.gitpando.com/v1/login/callback`
   - Sign-out redirect: `https://app.gitpando.com/`
   - After step 4 checks out, make the app.gitpando.com Redirect URI the
     default and set Initiate login URI to
     `https://app.gitpando.com/v1/login/browser`.

   No sign-in setting changes. The Worker builds the redirect URI from the
   address the browser used (`worker/src/accounts/signin.ts`:
   `${origin}/v1/login/callback`, and `${origin}/` after sign-out), so both
   addresses work once WorkOS lists both. The one setting that names the
   public address is `PUBLIC_ORIGIN` (`worker/wrangler.jsonc`,
   `https://app.gitpando.com`), and only a cloud agent's push uses it (see
   "What stays on the old address"). `pando login` uses WorkOS's own device
   page and needs nothing new.
2. **GitHub App "Pando"** (and "pando-mirror-dev" if it should work there
   too): set Homepage URL to `https://app.gitpando.com` and add the Callback
   URL `https://app.gitpando.com/v1/github/callback`, keeping the pando-dev one
   (GitHub allows up to 10). research/plans/github-mirror-2026-10-04/OWNER-SETUP.md,
   "Later", already says this.
3. **Anyone can download releases** must be on for ramos/pando's
   `projects/pando` (Settings), or the one-line install answers 401
   ("could not download"). The long form in the docs needs it too.

## Order (pando-ops)

Merge `domain` into main first. The only address setting in the Worker is
`DOCS_URL`, now `https://docs.gitpando.com`: the app's `/docs` redirects there
and its pages allow fetching What's new from it. So the docs go first.

1. **Docs.** deploy.sh's docs step, unchanged (`npx wrangler deploy` in
   `site/docs`). It now also attaches docs.gitpando.com. Change its check
   address `D` to `https://docs.gitpando.com` once it answers.
   - Check: `curl -sI https://docs.gitpando.com/get-started/` is 200;
     `curl -s https://docs.gitpando.com/whats-new.json` names "Pando at
     gitpando.com"; the old address still answers 200.
2. **App.** deploy.sh's worker step with the domain once:
   `npx wrangler deploy --tag $FULL --message "$SUBJ" --domain app.gitpando.com`
   (keeping `--domain` in deploy.sh does no harm). Set `U` to
   `https://app.gitpando.com` once it answers.
   - Check: `curl -s https://app.gitpando.com/healthz` is `ok`;
     `curl -sI https://app.gitpando.com/docs/cli/` is a 302 to
     `https://docs.gitpando.com/cli/`; `curl -s https://app.gitpando.com/install | head -3`
     is the script with `server='https://app.gitpando.com'`;
     pando-dev.plannotator.workers.dev/healthz still `ok`.
   - Sign-in (owner, after WorkOS step 1): open
     `https://app.gitpando.com/v1/login/browser?return_to=/v1/user`, sign in,
     land on JSON with your login; `https://app.gitpando.com/` shows the home.
   - `pando login` with no `--server` now signs in to app.gitpando.com (the
     CLI's default, `cli/internal/config/home.go`).
3. **Landing.** From `site/landing` in the deploy export (the worker's
   `npm ci` has run there):
   `PANDO_FONTS_DIR=/Users/ramos/pando/research/design/pando-2026-10-02/landing/fonts ../../worker/node_modules/.bin/wrangler deploy`.
   Its build step (`copy-fonts.sh`) copies Apple's SF fonts into
   `public/fonts/` (never committed); without `PANDO_FONTS_DIR` an export
   outside the meta layer finds none and the page uses system fonts.
   - Check: `curl -sI https://gitpando.com/` is 200 text/html;
     `curl -sI https://gitpando.com/install` is a 302 to
     `https://app.gitpando.com/install`; `curl -sI https://gitpando.com/fonts/SFNSMono.ttf`
     is 200.
   - End to end, in a throwaway HOME so nothing on the Mac changes:
     `H=$(mktemp -d); curl -fsSL https://gitpando.com/install | HOME=$H sh; $H/.local/bin/pando help`.
     It prints "Installed pando at ..." and ends with
     `pando login --server https://app.gitpando.com`.
   - Look: open https://gitpando.com/ ; "Bring your monorepo." shows the
     install line, `pando init`, and the app and docs links.

Until a release of `pando` is cut from this commit, the installed `pando` has
no default server, so `pando login` needs `--server`. The install script
prints the full command either way.

## What stays on the old address

- Machines signed in to pando-dev keep their credential and server
  (`~/.pando/credentials/<host>` is per host). To move one:
  `pando login --server https://app.gitpando.com`.
- Clones keep their remotes at pando-dev.plannotator.workers.dev, which keeps
  working. A person's push through either address sends CI the clone and
  status URLs of the address it came in on. A cloud agent's push comes in
  through its sandbox's gateway, http://pando.internal, which no CI machine
  can reach, so CI gets `PUBLIC_ORIGIN`'s instead (`worker/wrangler.jsonc`,
  `https://app.gitpando.com`; `worker/src/monorepo/hooks.ts`).
- Browser sessions are per host (the `__Host-pando_session` cookie), so people
  sign in again on app.gitpando.com.
- Buildkite webhook URLs already given out (`.../v1/integrations/buildkite/<id>`
  on workers.dev) keep working. New connections show app.gitpando.com when made
  there.
- Tests, cli/testbed and mac/Tests keep pando-dev.plannotator.workers.dev
  defaults; research/operational/gates/deploy.sh is pando-ops' to change.

## Rolling back

workers.dev stays on throughout, so nothing has to be undone for the old
addresses to work.

- **A Worker version:** `npx wrangler rollback` in `worker/` (or `site/docs`)
  goes back to the previous version; the custom domain stays attached.
- **Detach an address:** dashboard, Workers & Pages, the Worker, Settings,
  Domains & Routes, remove the custom domain (Cloudflare removes its DNS
  record). For docs and landing, also take `routes` out of their
  wrangler.jsonc, or the next deploy attaches it again.
- **Docs address in the app:** set `DOCS_URL` back to
  `https://pando-docs.plannotator.workers.dev` and deploy, if
  docs.gitpando.com has to go.
- WorkOS and the GitHub App keep both addresses, so sign-in works on either
  while you roll back.
