// Your settings' frame (mock `edit`): a short list at the side, Profile and
// Machines and Sessions, beside the page you are on. On a phone the list sits above it.
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LaptopIcon, PersonIcon, TerminalIcon } from "../../ui/Icons";
import { Page } from "../../ui/pages";
import { ownerLink } from "../../ui/paths";

const PAGES = [
  { to: "/settings/profile", label: "Profile", icon: <PersonIcon /> },
  { to: "/settings/machines", label: "Machines", icon: <LaptopIcon /> },
  { to: "/settings/sessions", label: "Sessions", icon: <TerminalIcon /> },
] as const;

export function SettingsFrame({ login, page, children }: { login: string; page: "profile" | "machines" | "sessions"; children: ReactNode }) {
  return (
    <Page crumbs={[{ label: login, link: ownerLink(login) }, { label: "settings" }]}>
      <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-14 narrow:gap-10 phone:grid-cols-[minmax(0,1fr)] phone:gap-5">
        <nav aria-label="Settings">
          <ul className="flex flex-col gap-0.5 phone:flex-row phone:gap-1">
            {PAGES.map((p) => (
              <li key={p.to}>
                <Link
                  to={p.to}
                  aria-current={p.to.endsWith(page) ? "page" : undefined}
                  className="flex h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 text-[14px] text-bark-dim hover:text-bark aria-[current=page]:bg-loam aria-[current=page]:text-bark *:[svg]:size-4 *:[svg]:text-ash"
                >
                  {p.icon}
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </Page>
  );
}
