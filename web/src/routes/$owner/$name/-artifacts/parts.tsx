// Small pieces the Artifacts tab and an artifact's page share: a size in
// words, the kind's icon, and who uploaded a version from where.
import type { ArtifactKind, ArtifactVersion } from "@pando/contract";
import { CodeIcon, FileIcon, ImageIcon } from "../../../../ui/Icons";

/** "880 B", "12 KB", "1.9 MB". */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;

  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "12 KB", or "1.9 MB, 5 files" when the document came with its images. */
export const sizeOf = (v: ArtifactVersion) => `${bytes(v.size)}${v.files.length > 1 ? `, ${v.files.length} files` : ""}`;

export function KindIcon({ kind, className = "size-4" }: { kind: ArtifactKind; className?: string }) {
  if (kind === "html") return <CodeIcon className={className} />;

  if (kind === "image") return <ImageIcon className={className} />;

  return <FileIcon className={className} />;
}

/** "web" from the browser; a machine's name from the CLI. */
export const fromWhere = (v: ArtifactVersion) => (v.via === "web" ? "web" : (v.machine ?? "cli"));
