// Where a file sits, above it: "pando / decisions / RULINGS.md", each folder a link.
import { Link } from "@tanstack/react-router";
import type { AppLink } from "../../../../ui/paths";

/** `inline` when it sits in a toolbar beside other controls. */
export function PathTrail({ root, folder, path, inline = false }: { root: string; folder: (dir: string) => AppLink; path: string; inline?: boolean }) {
  const parts = path.split("/");
  const crumb = "text-bark-dim hover:text-bark";

  const trail = (
    <span className="text-[13px] leading-[16px] text-ash">
        <Link {...folder("")} className={crumb}>
          {root}
        </Link>
        {" / "}
        {parts.slice(0, -1).map((p, i) => (
          <span key={i}>
            <Link {...folder(parts.slice(0, i + 1).join("/"))} className={crumb}>
              {p}
            </Link>
            {" / "}
          </span>
        ))}
      {parts.at(-1)}
    </span>
  );

  return inline ? trail : <div className="mb-3.5 flex items-center gap-4 phone:flex-wrap">{trail}</div>;
}
