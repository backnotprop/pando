// The strip over a project's files (mock releases/strip.html): main and its
// state in the branch page's words (passed, failed, running, not built), the
// newest build on main with its CI service's mark and when, then the latest
// release and when. A commit nothing reported on reads "not built", never
// green; a newer commit not built yet keeps the last build on main linked.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BuildState, CiBuild, Repo, RepoSummary } from "@pando/contract";
import { summaryQuery } from "../../../../api/releases";
import { CheckMark } from "../../../../ui/activity";
import { TagIcon } from "../../../../ui/Icons";
import { ciBuildLink, releaseLink } from "../../../../ui/paths";
import { refClass } from "../../../../ui/Ref";
import { ago, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";

const WORDS: Record<BuildState, { text: string; tone: string }> = {
  success: { text: "passed", tone: "text-bark-dim" },
  failure: { text: "failed", tone: "font-semibold text-rust" },
  error: { text: "failed", tone: "font-semibold text-rust" },
  pending: { text: "running", tone: "text-ash" },
  missing: { text: "not built", tone: "text-ash" },
  not_built: { text: "not built", tone: "text-ash" },
  unknown: { text: "checks unknown", tone: "text-ash" },
};

/** The build's name and number: its page in the CI tab (a monorepo's), else the service's. */
function BuildRef({ build }: { build: CiBuild }) {
  const { monorepo, info } = useMonorepo();
  const cls = refClass("object");

  const label = (
    <>
      {build.service === "buildkite" ? <CheckMark /> : null}
      {build.pipeline} #{build.number}
    </>
  );

  if (info.kind === "monorepo") {
    return (
      <Link {...ciBuildLink(monorepo.full, build.pipeline, build.number)} className={cls}>
        {label}
      </Link>
    );
  }

  return build.web_url ? (
    <a href={build.web_url} target="_blank" rel="noopener noreferrer" className={cls}>
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}

/** "4 min ago" for a finished build, "started 1 min ago" for a running one. */
function buildWhen(b: CiBuild, clock: number): string {
  if (b.finished_at) return ago(b.finished_at, clock);

  if (b.started_at) return `started ${ago(b.started_at, clock)}`;

  return b.created_at ? ago(b.created_at, clock) : "";
}

function Line({ repo, s }: { repo: Repo; s: RepoSummary }) {
  const { monorepo } = useMonorepo();
  const clock = useNow();
  const word = WORDS[s.main.state];
  const build = s.main.build;
  // The newest build on main is of an older commit: main's own is not built yet.
  const last = build !== null && build.sha !== s.main.sha;
  const rel = s.latest_release;

  return (
    <div aria-label="main's build and the latest release" className="mb-3.5 flex min-h-10 flex-wrap items-center gap-x-3.5 gap-y-1.5 px-0.5 text-[13.5px] text-bark-dim">
      <span className="inline-flex items-center gap-[7px] whitespace-nowrap">
        <span className="font-mono text-[13px] text-bark">{s.main.branch}</span>
        <span className={word.tone}>{word.text}</span>
        {build ? (
          <>
            <span aria-hidden="true" className="text-ash">
              ·
            </span>
            {last ? <span className="text-ash">last build</span> : null}
            <BuildRef build={build} />
            {last ? null : <span className="text-ash">{buildWhen(build, clock)}</span>}
          </>
        ) : null}
      </span>
      {rel ? (
        <span className="ml-auto inline-flex items-center gap-[7px] whitespace-nowrap phone:ml-0">
          <TagIcon className="size-3.5 text-ash" />
          <span>Latest release</span>
          <Link {...releaseLink(monorepo.full, repo.path, rel.tag)} className={refClass("object")}>
            {rel.tag}
          </Link>
          <span className="text-ash">{ago(rel.published_at, clock)}</span>
        </span>
      ) : null}
    </div>
  );
}

/** Drawn once read (the files never wait for it); nothing for a repo with no commits. */
export function Strip({ repo }: { repo: Repo }) {
  const { monorepo } = useMonorepo();
  const s = useQuery(summaryQuery(monorepo, repo.name)).data;

  return s && s.main.sha ? <Line repo={repo} s={s} /> : null;
}
