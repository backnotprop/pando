# References

Projects and documents Pando builds on or learns from, with their licences.
Checked 2026-10-02.

| Reference | What it is to Pando | Licence |
| --- | --- | --- |
| [Oak](https://oak.space) ([source](https://oak.space/oak/oak), [GitHub mirror](https://github.com/oakdotspace/oak)) | Prior art for agent-first version control: lazy mounts, branch rules, sorting every open branch into mergeable or closable without a checkout, diff modes. Its macOS FSKit mount app and extension (`macos/OakFS`) are what Pando.app (`mac/`) is derived from. | Apache 2.0 for the client, core library and `macos/OakFS`; the hosted oak.space service is under Oakspace Inc.'s terms |
| [ArtifactFS](https://github.com/cloudflare/artifact-fs) | Cloudflare's lazy git mount over a blobless clone with a copy-on-write overlay. The engine Pando's mount daemon is built from; the Linux mount as is. | Apache 2.0 |
| [jacobsa/fuse](https://github.com/jacobsa/fuse) | The Go FUSE library ArtifactFS uses (macFUSE or FUSE-T on macOS, `/dev/fuse` on Linux). | Apache 2.0 |
| [FSKit](https://developer.apple.com/documentation/fskit) | Apple's user-space file system framework (macOS 15.4+; path-URL volumes need macOS 26). Pando's macOS mount is an FSKit app extension. | Apple SDK; extensions need the `com.apple.developer.fskit.fsmodule` entitlement through an Apple Developer Program or Developer ID provisioning profile |
| [macFUSE](https://github.com/macfuse/macfuse) | The FUSE implementation ArtifactFS uses on macOS today. Not used by Pando's Mac mount. | Source-available with a no-commercial-bundling clause: "Redistributions in binary form, bundled with commercial software, are not allowed without specific prior written permission" |
| [FUSE-T](https://github.com/macos-fuse-t/fuse-t) | A kext-less FUSE for macOS over a local NFS server. Considered, not used. | Free for non-commercial use; commercial use needs a licence from its authors |
| [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) | The git storage Pando runs on: repos, refs, tokens, event subscriptions. | Cloudflare service terms |
| [Workers KV, Instant mode](https://blog.cloudflare.com/workers-kv-instant/) | A low-latency key-value mode in private beta (1 MB per namespace, one write per second). Optional for small, rarely changed monorepo settings. | Cloudflare service terms |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | The live tier's fan-out and the per-monorepo state. | Cloudflare service terms |
| [nimbus](https://github.com/cloudflare/nimbus) | Cloudflare's docs-site framework on Astro. `site/docs` is its scaffold (`@cloudflare/create-nimbus-docs` 0.7.9) and builds with `@cloudflare/nimbus-docs` 0.15.2, including the API reference from `docs/contracts/api-v1.yaml`. | MIT |
| [Plannotator](https://github.com/backnotprop/plannotator) | The human review surface (`plannotator review --patch-file`). | MIT or Apache 2.0 (dual) |
| [Competition page](https://www.cloudflare.com/git-competition/) and [Official Rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) | "Build the Next-Gen Git Platform on Cloudflare": submit by October 14, 2026, 11:59 PM PDT; a 5 to 10 minute video, the source repository, run instructions; MIT, Apache 2.0 or BSD. | Cloudflare, Inc. contest rules |

The competition URLs above are where the pages were published; local copies
of both, read on 2026-10-02, are kept with the proposal outside this repo.
