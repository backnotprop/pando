// A commit's checks, as GitHub lists them, on a branch's page (its head) and a
// commit's page: each required or reported check with its CI service's mark,
// its state in words and its time.
import type { Checks, Repo, Status } from "@pando/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CheckRun, checkRunsQuery } from "../../../../api/projects";
import { fallback } from "../../../../live/rows";
import { CheckMark } from "../../../../ui/activity";
import { useArrivals } from "../../../../ui/arrival";
import { Empty } from "../../../../ui/controls";
import { ciBuildLink } from "../../../../ui/paths";
import { refClass } from "../../../../ui/Ref";
import { elapsed, useSeconds } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";

/** A check's state in words: its job's, when a CI service runs it; else its status's. */
function checkWord(s: Status | undefined, run: CheckRun | undefined): string {
  if (run) return run.job.state;

  if (!s) return "not reported";

  if (s.state === "superseded") return "superseded";

  return s.state === "success" ? "passed" : s.state === "pending" ? "running" : s.state === "failure" ? "failed" : "errored";
}

const toneOf = (word: string) => (word === "passed" ? "text-bark-dim" : word === "failed" || word === "errored" ? "font-semibold text-rust" : "text-ash");

/**
 * Each required or reported check, as GitHub lists them: its CI service's
 * mark, its name (opening its job on the build's page), its state in words,
 * and its time, which ticks each second while it runs. A check that moves
 * while the page is open plays the arrival.
 */
export function CheckRows({ repo, sha, checks, live }: { repo: Repo; sha: string; checks: Checks; live: boolean }) {
  const { monorepo, info } = useMonorepo();
  // Read from Pando's stored builds, not only when a status names a service: a job shows the moment it is queued.
  const runs = useQuery({ ...checkRunsQuery(monorepo, repo.name, sha), refetchInterval: fallback(live) }).data?.runs;
  const names = [...new Set([...(checks.required ?? []), ...checks.statuses.map((s) => s.context), ...(runs?.keys() ?? [])])];
  const words = names.map((name) => checkWord(checks.statuses.find((x) => x.context === name), runs?.get(name)));
  const clock = useSeconds(words.includes("running"));
  const arrived = useArrivals(runs ? names.map((name, i) => ({ key: name, state: words[i] ?? "" })) : undefined);

  // pando.toml unreadable or broken: which checks are required is not known (the Merge box gives the reason in full).
  const unknown =
    checks.state === "unknown" ? (
      <p title={checks.checks_unknown ?? undefined} className="mb-2.5 text-[13px] text-ash">
        Required checks unknown
      </p>
    ) : null;

  if (!names.length) return unknown ?? <Empty>None required.</Empty>;

  return (
    <>
      {unknown}
      <ul aria-label="Checks" className="grid gap-2.5">
        {names.map((name, i) => {
          const s = checks.statuses.find((x) => x.context === name);
          const run = runs?.get(name);
          const word = words[i] ?? "";
          const mark = s?.app === "buildkite" || run?.build.service === "buildkite";
          // A monorepo's build has its page here; a plain repo's opens in the service.
          const page = run && info.kind === "monorepo" ? ciBuildLink(monorepo.full, run.build.pipeline, run.build.number) : null;
          const url = run?.job.web_url ?? s?.target_url ?? null;
          const label = <span className="fox-cool">{name}</span>;

          return (
            <li key={`${name}:${word}`} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[13px] ${arrived(name) ? "arrived" : ""}`}>
              <span className="text-bark-dim">
                {mark ? <CheckMark /> : null}
                {page && run ? (
                  <Link {...page} search={{ job: run.job.id }} className={refClass("person")}>
                    {label}
                  </Link>
                ) : url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className={refClass("person")}>
                    {label}
                  </a>
                ) : (
                  <span className="font-semibold text-bark">{label}</span>
                )}{" "}
                <span className={`fox-cool text-[13px] whitespace-nowrap ${toneOf(word)}`}>{word}</span>
              </span>
              <span className="fox-cool text-[12.5px] whitespace-nowrap text-ash">{run ? elapsed(run.job, clock) : ""}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
