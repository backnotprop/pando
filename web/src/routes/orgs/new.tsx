// New organization (SPEC 4.4): its name, which is its address and shares the
// namespace with people's logins, checked as you type (its characters, the
// reserved names, and whether a person or an org has it), and a display name. You become its
// first owner, and land on its page.
import { ApiError, Login, RESERVED_NAMESPACES } from "@pando/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useState } from "react";
import { isMissing } from "../../api/client";
import { createOrg, nameQuery, ORG_LIMITS } from "../../api/orgs";
import { button, field } from "../../ui/controls";
import { Page, Title } from "../../ui/pages";

export const Route = createFileRoute("/orgs/new")({
  component: NewOrg,
});

const parseLogin = Schema.decodeUnknownResult(Login);

/** The value once it has stopped changing for a moment, so a check runs per pause, not per key. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);

    return () => clearTimeout(t);
  }, [value, ms]);

  return settled;
}

type Check = { ok: boolean; text: string } | null;

/** What the name field says under it: the rule, a problem, or that the name is free. */
function useNameCheck(name: string): Check {
  const settled = useSettled(name);
  const login = parseLogin(settled);
  const valid = Result.isSuccess(login) ? login.success : null;
  const owner = useQuery(nameQuery(valid));

  if (!name) return null;

  if (name !== settled) return null;

  if (!valid) return { ok: false, text: "Use lowercase letters, digits and single hyphens, up to 39 characters, with no hyphen at either end." };

  if (RESERVED_NAMESPACES.has(valid)) return { ok: false, text: reserved(valid) };

  if (owner.data) return { ok: false, text: `${valid} is taken.` };

  if (owner.error && isMissing(owner.error)) return { ok: true, text: `${valid} is available.` };

  return null;
}

const reserved = (name: string) => `${name} is reserved: Pando uses it for its own pages.`;

/** The server's refusal, in plain words. */
function refusal(error: Error, name: string): string {
  if (error instanceof ApiError && error.code === "namespace_taken") return `${name} is taken.`;

  if (error instanceof ApiError && error.code === "reserved_name") return reserved(name);

  return error.message;
}

const Field = ({ label, id, children, under }: { label: string; id: string; children: ReactNode; under: ReactNode }) => (
  <div className="flex flex-col gap-2">
    <label htmlFor={id} className="text-[14px] leading-5 font-semibold">
      {label}
    </label>
    {children}
    <p className="min-h-[18px] text-[12.5px] leading-[18px]">{under}</p>
  </div>
);

function NewOrg() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [display, setDisplay] = useState("");
  const check = useNameCheck(name);

  const create = useMutation({
    mutationFn: () => createOrg(name, display.trim()),
    onSuccess: async (org) => {
      qc.setQueryData(["owner", org.login], org);
      await qc.invalidateQueries({ queryKey: ["orgs"] });
      await navigate({ to: "/$owner", params: { owner: org.login } });
    },
  });

  return (
    <Page crumbs={[{ label: "new organization" }]}>
      <Title>New organization</Title>
      <p className="mt-2 max-w-[560px] text-[14px] text-bark-dim">Everyone you add can open and push to all of its repositories. You are its first owner.</p>
      <form
        className="mt-8 flex max-w-[560px] flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field
          label="Name"
          id="org-login"
          under={check ? <span className={check.ok ? "text-bark-dim" : "text-rust"}>{check.text}</span> : <span className="text-ash">Its address: lowercase letters, digits and single hyphens.</span>}
        >
          <span className="flex items-center gap-2.5">
            <span className="text-[13.5px] text-ash">{location.host}/</span>
            <input
              id="org-login"
              className={`${field} min-w-0 flex-1`}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="plannotator"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
            />
          </span>
        </Field>
        <Field label="Display name" id="org-name" under={<span className="text-ash">Optional, as in Plannotator; up to {ORG_LIMITS.name} characters.</span>}>
          <input id="org-name" className={field} autoComplete="off" maxLength={ORG_LIMITS.name} value={display} onChange={(e) => setDisplay(e.target.value)} />
        </Field>
        <div>
          <button type="submit" className={button("solid")} disabled={create.isPending || check?.ok === false}>
            Create organization
          </button>
          {create.error ? <p className="mt-2 text-[13px] text-rust">{refusal(create.error, name)}</p> : null}
        </div>
      </form>
    </Page>
  );
}
