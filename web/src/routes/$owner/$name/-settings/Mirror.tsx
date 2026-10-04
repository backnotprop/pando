// Settings, "Mirror to GitHub" (SPEC 5.1; mocks in research/design/
// pando-ui-2026-10-03/github-mirror): one switch and a short list, each
// control only when it means something. Off: one line. Turning it on opens
// the setup dialog (MirrorSetup). On: one row per source with one quiet
// status; a row in trouble adds one sentence and Retry. Details adds the
// commit last sent, Change and a switch per row, then the GitHub account,
// Manage on GitHub and Disconnect. The switch off after setup pauses. Rows
// move by the page's socket (mirror.updated), and every 3 s while one is on
// its way.
import type { GithubRepos, Mirror as MirrorView, MirrorTarget } from "@pando/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { disconnectMirror, githubReposQuery, mirrorKey, mirrorQuery, moving, MOVING_MS, retryMirror, saveMirrorTargets, setMirrorOn, type TargetChoice } from "../../../../api/mirror";
import { fallback, useRows } from "../../../../live/rows";
import { button, lnk, Refusal } from "../../../../ui/controls";
import { Chevron } from "../../../../ui/Icons";
import { Ref } from "../../../../ui/Ref";
import { since, useNow } from "../../../../ui/time";
import { useMonorepo } from "../-frame/heads";
import { ChangeMenu, GithubMark, type Pick, pickByName, sourceName, suggestedName, textButton, Toggle } from "./mirror-parts";
import { MirrorSetup, type SetupStep } from "./MirrorSetup";

const TOPICS = ["kind:mirror.updated"];

const behindText = (n: number) => (n >= 100 ? "100+ commits behind" : n === 1 ? "1 commit behind" : `${n} commits behind`);

type Tone = "quiet" | "warn" | "bad";

const TONE: Record<Tone, string> = { quiet: "text-ash", warn: "text-clay", bad: "text-rust" };

/** A row's one status, and its colour. */
interface Status {
  text: string;
  tone: Tone;
}

function status(t: MirrorTarget, clock: number): Status {
  const sent = t.last ? `Up to date · ${since(t.last.at, clock)}` : "Starting";

  switch (t.state) {
    case "off":
      return { text: "Off", tone: "quiet" };
    case "not_started":
      return { text: "Starting", tone: "quiet" };
    case "up_to_date":
      return { text: sent, tone: "quiet" };
    case "waiting":
      return { text: t.behind ? behindText(t.behind) : sent, tone: "quiet" };
    case "paused":
      return { text: t.behind ? `Paused · ${behindText(t.behind)}` : "Paused", tone: "quiet" };
    case "mirroring":
      return { text: "Mirroring", tone: "quiet" };
    case "retrying":
      return { text: "Trying again", tone: "warn" };
    case "no_access":
      return { text: "No access", tone: "bad" };
    case "not_found":
      return { text: "Not found", tone: "bad" };
    case "refused":
      return { text: "Refused", tone: "bad" };
  }
}

/** The page's ?mirror=: GitHub sent the browser back to step 2 (`match`) or to choose an account (`choose`). Read once. */
interface Asked {
  step: SetupStep | null;
  choose: boolean;
}

function askedStep(): Asked {
  const asked = new URLSearchParams(location.search).get("mirror");

  return { step: asked === "match" ? "match" : asked === "choose" ? "connect" : null, choose: asked === "choose" };
}

const rowCols = "grid min-h-11 items-center gap-2.5 py-2 phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-x-3 phone:gap-y-0.5 phone:py-2.5";

/** One sentence and Retry, under a row in trouble only. */
function Problem({ t }: { t: MirrorTarget }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const retry = useMutation({ mutationFn: () => retryMirror(monorepo, t.repo), onSettled: () => qc.invalidateQueries({ queryKey: mirrorQuery(monorepo).queryKey }) });

  // Shown while the row is in that state (not while a run is trying again, nor paused).
  if (!t.problem || t.state !== t.problem.code) return null;

  return (
    <div className="-mt-1 flex items-center gap-3.5 pb-3 pl-[188px] text-[13px] phone:mt-0 phone:flex-wrap phone:gap-y-2 phone:pl-0">
      <span className={`min-w-0 flex-1 ${t.problem.code === "retrying" ? "text-clay" : "text-rust"}`}>{t.problem.message}</span>
      <span className="flex flex-none gap-2 phone:basis-full">
        <button type="button" className={button("quiet", 28)} disabled={retry.isPending} onClick={() => retry.mutate()}>
          Retry
        </button>
      </span>
      <Refusal error={retry.error} />
    </div>
  );
}

/** A paused or switched-off row's link: Ash. */

/** The GitHub repository, a link (a new tab), with an arrow before it on a phone. */
function GithubLink({ t, dim }: { t: MirrorTarget; dim: boolean }) {
  if (!t.github) return null;

  // What the row is about, as links R draws an object (ui/Ref.tsx); faded while paused or off.
  return (
    <>
      <span className="hidden text-ash phone:inline">→</span>
      <Ref kind="object" href={t.github.url} className={`${dim ? "opacity-60" : ""} min-w-0 overflow-hidden text-ellipsis whitespace-nowrap`}>
        {t.github.full_name}
      </Ref>
    </>
  );
}

/** A row with Details closed: the source, an arrow, the GitHub repository and one quiet status. Off: greyed, "Off", nothing else. */
function Row({ t, label }: { t: MirrorTarget; label: string }) {
  const clock = useNow();
  const s = status(t, clock);
  const off = t.state === "off";

  return (
    <li className="border-t border-rule-faint last:border-b">
      <div className={`${rowCols} grid-cols-[minmax(0,150px)_18px_minmax(0,1fr)_auto]`}>
        <span className={`overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap phone:col-start-1 phone:row-start-1 ${off ? "text-ash" : ""}`}>{label}</span>
        <span className="text-center text-[13px] text-ash phone:hidden">{off ? "" : "→"}</span>
        <span className={`flex min-w-0 items-center gap-2.5 text-[13.5px] phone:col-span-full phone:row-start-2 ${off ? "phone:hidden" : ""}`}>{off ? null : <GithubLink t={t} dim={t.state === "paused"} />}</span>
        <span className={`text-right text-[12.5px] whitespace-nowrap phone:col-start-2 phone:row-start-1 ${TONE[s.tone]}`}>{s.text}</span>
      </div>
      <Problem t={t} />
    </li>
  );
}

/** A row with Details open: the commit last sent and when, Change, and the row's own switch. */
function DetailRow({ t, label, current, list, account, name, busy, onSave }: { t: MirrorTarget; label: string; current: Pick; list: GithubRepos | undefined; account: string; name: string; busy: boolean; onSave: (pick: Pick, on: boolean) => void }) {
  const clock = useNow();
  const s = status(t, clock);

  return (
    <li className="border-t border-rule-faint last:border-b">
      <div className={`${rowCols} grid-cols-[minmax(0,150px)_18px_minmax(0,1fr)_150px_44px]`}>
        <span className={`overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap phone:col-start-1 phone:row-start-1 ${t.on ? "" : "text-ash"}`}>{label}</span>
        <span className="text-center text-[13px] text-ash phone:hidden">→</span>
        <span className="flex min-w-0 items-center gap-2.5 text-[13.5px] phone:col-span-full phone:row-start-2">
          <GithubLink t={t} dim={!t.on || t.state === "paused"} />
          <ChangeMenu list={list} account={account} name={name} current={current} disabled={busy} onPick={(p) => onSave(p, t.on)} />
        </span>
        <span className="text-[12.5px] whitespace-nowrap text-ash phone:col-span-full phone:row-start-3">
          {t.on && t.last ? (
            <>
              <code className="text-[12.5px] text-bark-dim">{t.last.commit.slice(0, 7)}</code> · {since(t.last.at, clock)}
            </>
          ) : (
            <span className={TONE[s.tone]}>{s.text}</span>
          )}
        </span>
        <span className="flex justify-end phone:col-start-2 phone:row-start-1">
          {/* A row never matched (a project added later) takes the repository with its name, once the list is read. */}
          <Toggle label={`Mirror ${label}`} size="sm" checked={t.on} disabled={busy || (!t.github && !list)} onChange={(on) => onSave(current, on)} />
        </span>
      </div>
      <Problem t={t} />
    </li>
  );
}

/** Disconnect asks once more in place, as the CI tab's does. */
function Disconnect({ onGone }: { onGone: () => void }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [sure, setSure] = useState(false);

  const gone = useMutation({
    mutationFn: () => disconnectMirror(monorepo),
    onSuccess: onGone,
    onSettled: () => qc.invalidateQueries({ queryKey: mirrorKey(monorepo) }),
  });

  return (
    <span className="ml-auto flex flex-col items-end phone:ml-0 phone:items-start">
      <button type="button" className={button(sure ? "danger" : "quiet", 28)} disabled={gone.isPending} onBlur={() => setSure(false)} onClick={() => (sure ? gone.mutate() : setSure(true))}>
        {sure ? "Disconnect GitHub" : "Disconnect"}
      </button>
      <Refusal error={gone.error} />
    </span>
  );
}

/** The rows, and Details: closed, or open with each row's commit, Change and switch, then the account. */
function Rows({ mirror }: { mirror: MirrorView }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useQuery({ ...githubReposQuery(monorepo), enabled: open && mirror.connection !== null }).data;
  const account = list?.account ?? mirror.connection?.login ?? "";
  const label = (t: MirrorTarget) => sourceName(t.path, monorepo.full);
  const nameOf = (t: MirrorTarget) => suggestedName(t.path, monorepo.name);
  const current = (t: MirrorTarget): Pick => (t.github ? { github: t.github, create: null } : pickByName(list, nameOf(t)));

  const save = useMutation({
    mutationFn: (targets: TargetChoice[]) => saveMirrorTargets(monorepo, mirror.mode, targets),
    onSuccess: (saved) => {
      if (saved.authorize_url) return location.assign(saved.authorize_url);
      qc.setQueryData(mirrorQuery(monorepo).queryKey, saved.mirror);
    },
  });

  // Change and a row's switch send the full list: that row changed, every other as it is.
  const saveRow = (repo: string, pick: Pick, on: boolean) =>
    save.mutate(
      mirror.targets.map((t) =>
        t.repo === repo ? { repo, on, github_id: pick.github?.id ?? null, create: pick.create } : { repo: t.repo, on: t.on, github_id: t.github?.id ?? null, create: null },
      ),
    );

  return (
    <>
      <ul aria-label="Mirror to GitHub" className="mt-2.5">
        {mirror.targets.map((t) =>
          open ? (
            <DetailRow
              key={t.repo}
              t={t}
              label={label(t)}
              current={current(t)}
              list={list}
              account={account}
              name={nameOf(t)}
              busy={save.isPending}
              onSave={(p, on) => saveRow(t.repo, p, on)}
            />
          ) : (
            <Row key={t.repo} t={t} label={label(t)} />
          ),
        )}
      </ul>
      <Refusal error={save.error} />
      <div className="mt-3">
        <button type="button" className={textButton} aria-expanded={open} onClick={() => setOpen(!open)}>
          Details
          <Chevron className={`size-[13px] text-ash ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && mirror.connection ? (
        <div className="mt-3.5 flex items-center gap-3 text-[13px] text-bark-dim phone:flex-wrap">
          <GithubMark className="size-4 flex-none" />
          <span>{mirror.connection.login}</span>
          <a href={mirror.connection.manage_url} target="_blank" rel="noopener noreferrer" className={`${lnk} ml-1`}>
            Manage on GitHub
          </a>
          <Disconnect onGone={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}

/** The section, between Name and Transfer on Settings (owners). */
export function Mirror() {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const live = useRows(monorepo, TOPICS, () => void qc.invalidateQueries({ queryKey: mirrorQuery(monorepo).queryKey }));
  const q = useQuery({ ...mirrorQuery(monorepo), refetchInterval: (query) => (query.state.data?.targets.some((t) => moving(t.state)) ? MOVING_MS : fallback(live)) });
  const [asked] = useState(askedStep);
  const [step, setStep] = useState<SetupStep | null>(asked.step);

  const toggle = useMutation({
    mutationFn: (on: boolean) => setMirrorOn(monorepo, on),
    onSuccess: (mirror) => qc.setQueryData(mirrorQuery(monorepo).queryKey, mirror),
  });

  // Back from GitHub: the dialog opens where it was sent, and the address loses ?mirror=.
  useEffect(() => {
    if (asked.step) void navigate({ to: "/$owner/$name/settings", params: { owner: monorepo.owner, name: monorepo.name }, replace: true });
  }, [asked.step, navigate, monorepo.owner, monorepo.name]);

  const mirror = q.data;
  const started = mirror?.started ?? false;
  const configured = mirror?.app.configured ?? true;
  // While the section's switch is being saved, it shows where it is going.
  const checked = started ? (toggle.isPending && toggle.variables !== undefined ? toggle.variables : (mirror?.on ?? false)) : step !== null;

  const flip = (on: boolean) => {
    if (!mirror) return;

    if (started) return toggle.mutate(on);
    setStep(on ? (mirror.connection ? "match" : "connect") : null);
  };

  return (
    <section className="mt-11">
      <div className="mb-1.5 flex items-center gap-3">
        <h2 className="text-[14px] leading-5 font-semibold">Mirror to GitHub</h2>
        {mirror ? (
          <span className="ml-auto flex">
            <Toggle label="Mirror to GitHub" checked={checked} disabled={(!configured && !started) || toggle.isPending} onChange={flip} />
          </span>
        ) : null}
      </div>
      {mirror && started ? (
        <Rows mirror={mirror} />
      ) : mirror ? (
        <>
          <p className="text-[13.5px] text-bark-dim">Mirror this repository&apos;s projects to GitHub.</p>
          {configured ? null : <p className="mt-1 text-[13px] text-ash">The GitHub App is not set up on this server.</p>}
          <MirrorSetup mirror={mirror} step={configured ? step : null} choose={asked.choose} onStep={setStep} onClose={() => setStep(null)} />
        </>
      ) : null}
      <Refusal error={q.error ?? toggle.error} />
    </section>
  );
}
