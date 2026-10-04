// Turning Mirror to GitHub on: a two-step dialog that ends (Base UI's Dialog;
// a sheet from the bottom on a phone). Step 1 connects GitHub (or, after
// GitHub named several accounts, lists them); step 2 matches each source to
// the GitHub repository with its name, or Create, and starts mirroring.
// Closing it at either step leaves the section off.
import type { GithubRepos, Mirror, MirrorMode } from "@pando/contract";
import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { chooseInstallation, connectPath, githubChoicesQuery, githubReposQuery, mirrorQuery, saveMirrorTargets } from "../../../../api/mirror";
import { Avatar } from "../../../../ui/Avatar";
import { button, Refusal } from "../../../../ui/controls";
import { CheckIcon } from "../../../../ui/Icons";
import { useMonorepo } from "../-frame/heads";
import { ChangeMenu, GithubMark, type Pick, pickByName, sourceName, suggestedName } from "./mirror-parts";

export type SetupStep = "connect" | "match";

/** A source in the match step: its key in the API, and its path (projects/<name>, "" for the files outside projects/, "*" for the whole repository). */
interface Source {
  repo: string;
  path: string;
}

const WHOLE: Source = { repo: "*", path: "*" };

function Step({ n, title }: { n: 1 | 2; title: string }) {
  return (
    <>
      <div className="mb-1.5 text-[12px] text-ash">{n} of 2</div>
      <Dialog.Title className="mb-1.5 text-[16px] leading-[22px] font-semibold">{title}</Dialog.Title>
    </>
  );
}

/** Step 1: Continue on GitHub, or one of the accounts GitHub named. */
function Connect({ choose, onChosen, onCancel }: { choose: boolean; onChosen: () => void; onCancel: () => void }) {
  const { monorepo } = useMonorepo();
  const qc = useQueryClient();
  const choices = useQuery({ ...githubChoicesQuery(monorepo), enabled: choose }).data ?? [];

  const use = useMutation({
    mutationFn: (installation: number) => chooseInstallation(monorepo, installation),
    onSuccess: (mirror) => {
      qc.setQueryData(mirrorQuery(monorepo).queryKey, mirror);
      onChosen();
    },
  });

  return (
    <>
      <Step n={1} title="Connect GitHub" />
      {choices.length ? (
        <>
          <Dialog.Description className="mb-3 text-[13.5px] leading-5 text-bark-dim">Pick the GitHub account to mirror to.</Dialog.Description>
          <ul>
            {choices.map((c) => (
              <li key={c.installation_id} className="flex min-h-11 items-center gap-2.5 border-t border-rule-faint text-[13.5px] last:border-b">
                <Avatar name={c.login} org={c.type === "Organization"} size={20} />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{c.login}</span>
                <button type="button" className={`${button("quiet", 28)} ml-auto`} disabled={use.isPending} onClick={() => use.mutate(c.installation_id)}>
                  Use {c.login}
                </button>
              </li>
            ))}
          </ul>
          <Refusal error={use.error} />
        </>
      ) : (
        <Dialog.Description className="mb-4 text-[13.5px] leading-5 text-bark-dim">
          Install Pando&apos;s GitHub app on your account or organization, and pick the repositories it may push to.
        </Dialog.Description>
      )}
      <div className="mt-[18px] flex gap-2">
        <button type="button" className={button("quiet", 30)} onClick={onCancel}>
          Cancel
        </button>
        {choices.length ? null : (
          <a href={connectPath(monorepo)} className={`${button("solid", 30)} ml-auto gap-1.5`}>
            <GithubMark className="size-4" />
            Continue on GitHub
          </a>
        )}
      </div>
    </>
  );
}

/** "a", "a and b", "a, b and c". */
const listed = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`);

/** One source's row: its tick, its name, an arrow, its GitHub repository (or Create), and Change. */
function MatchRow({ label, pick, on, onTick, list, account, name, onPick }: { label: string; pick: Pick; on: boolean; onTick: (on: boolean) => void; list: GithubRepos | undefined; account: string; name: string; onPick: (p: Pick) => void }) {
  return (
    <li className="grid min-h-11 grid-cols-[18px_minmax(0,150px)_14px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-rule-faint text-[13.5px] last:border-b phone:grid-cols-[18px_minmax(0,1fr)_auto] phone:gap-x-2.5 phone:gap-y-0.5 phone:py-2">
      <Checkbox.Root
        aria-label={`Mirror ${label}`}
        checked={on}
        onCheckedChange={onTick}
        className="flex size-4 cursor-pointer items-center justify-center rounded-[4px] shadow-[inset_0_0_0_1px_var(--rule-hi)] data-checked:bg-bark data-checked:text-soil data-checked:shadow-none phone:row-span-2 phone:self-start phone:mt-0.5"
      >
        <Checkbox.Indicator>
          <CheckIcon className="block size-3" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span className={`overflow-hidden text-ellipsis whitespace-nowrap ${on ? "" : "text-ash"}`}>{label}</span>
      <span className="text-[13px] text-ash phone:hidden">→</span>
      <span className={`overflow-hidden text-ellipsis whitespace-nowrap phone:col-start-2 phone:row-start-2 ${on ? "phone:text-bark-dim" : "text-ash"}`}>
        <span className="hidden text-ash phone:inline">→ </span>
        {pick.github ? (
          pick.github.full_name
        ) : (
          <>
            <span className={on ? "text-clay" : ""}>Create</span> {account}/{pick.create}
          </>
        )}
      </span>
      <span className="phone:col-start-3 phone:row-start-1">
        <ChangeMenu list={list} account={account} name={name} current={pick} onPick={onPick} />
      </span>
    </li>
  );
}

/** Step 2: the mode, each source matched by name (ticked), Change, and Start mirroring. */
function Match({ mirror, onBack, onDone }: { mirror: Mirror; onBack: () => void; onDone: () => void }) {
  const { monorepo, info } = useMonorepo();
  const qc = useQueryClient();
  const list = useQuery(githubReposQuery(monorepo));
  const account = list.data?.account ?? mirror.connection?.login ?? "";
  const [mode, setMode] = useState<MirrorMode>("projects");
  // What the person changed; every other source keeps its match by name, ticked.
  const [picked, setPicked] = useState<ReadonlyMap<string, Pick>>(new Map());
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const sources: Source[] = mode === "whole" ? [WHOLE] : mirror.mode === "projects" ? mirror.targets.map((t) => ({ repo: t.repo, path: t.path })) : [];
  const nameOf = (s: Source) => suggestedName(s.path, monorepo.name);
  const pickOf = (s: Source) => picked.get(s.repo) ?? pickByName(list.data, nameOf(s));
  const ticked = sources.filter((s) => !off.has(s.repo));
  const publicNames = ticked.flatMap((s) => (pickOf(s).github?.private === false ? [pickOf(s).github?.full_name ?? ""] : []));

  const start = useMutation({
    mutationFn: () =>
      saveMirrorTargets(
        monorepo,
        mode,
        sources.map((s) => {
          const p = pickOf(s);

          return { repo: s.repo, on: !off.has(s.repo), github_id: p.github?.id ?? null, create: p.create };
        }),
      ),
    onSuccess: (saved) => {
      // Creating repositories takes one more trip through GitHub; Pando returns to Settings after it.
      if (saved.authorize_url) return location.assign(saved.authorize_url);
      qc.setQueryData(mirrorQuery(monorepo).queryKey, saved.mirror);
      onDone();
    },
  });

  const tick = (repo: string, on: boolean) => setOff((was) => (on ? new Set([...was].filter((r) => r !== repo)) : new Set([...was, repo])));

  return (
    <>
      <Step n={2} title="Match" />
      {info.kind === "monorepo" ? (
        <div role="radiogroup" aria-label="Mirror" className="mt-0.5 mb-3.5 inline-flex gap-0.5 rounded-lg p-0.5 shadow-[inset_0_0_0_1px_var(--rootline)]">
          {(["projects", "whole"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`inline-flex h-7 items-center rounded-md px-3 text-[13px] whitespace-nowrap ${mode === m ? "bg-loam text-bark shadow-[inset_0_0_0_1px_var(--rule-hi)]" : "text-ash hover:text-bark-dim"}`}
            >
              {m === "projects" ? "Each project" : "Whole repository"}
            </button>
          ))}
        </div>
      ) : null}
      <ul aria-label="Match">
        {sources.map((s) => (
          <MatchRow
            key={s.repo}
            label={sourceName(s.path, monorepo.full)}
            pick={pickOf(s)}
            on={!off.has(s.repo)}
            onTick={(on) => tick(s.repo, on)}
            list={list.data}
            account={account}
            name={nameOf(s)}
            onPick={(p) => setPicked((was) => new Map(was).set(s.repo, p))}
          />
        ))}
      </ul>
      {publicNames.length ? (
        <p className="mt-3 text-[12.5px] leading-[18px] text-clay">
          {listed(publicNames)} {publicNames.length > 1 ? "are" : "is"} public. Everything in {mode === "whole" ? "this repository" : publicNames.length > 1 ? "their history" : "its history"} will be public.
        </p>
      ) : null}
      <Refusal error={list.error ?? start.error} />
      <div className="mt-[18px] flex gap-2">
        <button type="button" className={button("quiet", 30)} onClick={onBack}>
          Back
        </button>
        <button type="button" className={`${button("solid", 30)} ml-auto`} disabled={!ticked.length || list.isPending || start.isPending || start.isSuccess} onClick={() => start.mutate()}>
          Start mirroring
        </button>
      </div>
    </>
  );
}

/** The dialog. `step` null is closed; closing it (Cancel, Escape, outside) calls onClose, which leaves the section off. */
export function MirrorSetup({ mirror, step, choose, onStep, onClose }: { mirror: Mirror; step: SetupStep | null; choose: boolean; onStep: (s: SetupStep) => void; onClose: () => void }) {
  // Matching needs a connection; without one the dialog starts at step 1.
  const shown = step === "match" && !mirror.connection ? "connect" : step;

  return (
    <Dialog.Root
      open={shown !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* The menus' layer (z-10): Change's menu opens after the dialog, so its portal comes later and sits above it. */}
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-10 bg-[color-mix(in_srgb,var(--soil)_72%,transparent)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          className="fixed top-[150px] left-1/2 z-10 w-[480px] -translate-x-1/2 rounded-xl border border-rootline bg-pop px-[22px] pt-[22px] pb-5 shadow-pop outline-none transition-[opacity,translate] duration-200 ease-pando data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-opacity phone:inset-x-0 phone:top-auto phone:bottom-0 phone:w-auto phone:translate-x-0 phone:rounded-b-none phone:rounded-t-[14px] phone:px-4 phone:pt-5 phone:pb-7 phone:data-ending-style:translate-y-full phone:data-starting-style:translate-y-full"
        >
          {shown === "match" ? <Match mirror={mirror} onBack={() => onStep("connect")} onDone={onClose} /> : <Connect choose={choose} onChosen={() => onStep("match")} onCancel={onClose} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
