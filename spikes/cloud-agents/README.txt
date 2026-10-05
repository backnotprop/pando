Cloud-agents spike. Throwaway; not product code. See the lane's report.

Run (Docker needed; this lane used its own Colima profile):
  colima start -p cloud-agents
  export DOCKER_HOST=unix://$HOME/.colima/cloud-agents/docker.sock
  (cd ../../worker && npm ci && [ -f .dev.vars ] || echo "PANDO_BOOTSTRAP=<any local value>" > .dev.vars)
  npm install
  npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to .state   (from ../../worker, with --persist-to ../spikes/cloud-agents/.state)
  npx wrangler dev -c wrangler.jsonc -c ../../worker/wrangler.jsonc --port 8863 --inspector-port 9363 --persist-to .state --ip 127.0.0.1
  node run-spike2.mjs
  colima stop -p cloud-agents

Pando's Worker needs ../../web/dist to exist (an empty index.html will do)
and talks to the real Artifacts namespace pando-dev (wrangler login). The
driver deletes the repository it makes.

Spikes:
  1  PiHarness session in a Durable Object survives a full restart (scripted model).
  2  The session's container clones and pushes through Pando's door; the credential stays outside.
  3  Recall after the container is destroyed: transcript kept, workspace re-cloned from the branch.
  4  A container snapshot restores the workspace (local dev).
Results: spike2-run.txt.
