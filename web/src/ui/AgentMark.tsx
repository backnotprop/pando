// The coding agents by their vendors' own marks (owner rulings, 2026-10-04; sources in marks/SOURCES.md), and their
// names as a session row says them: "Claude Code, Opus 5.5 +1". Each mark is its unchanged SVG used as a mask, in
// one colour: Claude's terracotta, the text colour for Codex and OpenCode; Pi is redrawn as its ten cells in its
// own three colours, as Pi draws itself.
import claude from "./marks/claude.svg";
import codex from "./marks/codex.svg";
import custom from "./marks/customagent.svg";
import opencode from "./marks/opencode.svg";

export type Program = "claude-code" | "codex" | "pi" | "opencode";

export const PROGRAM_NAME: Record<Program, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

const MASK: Record<Exclude<Program, "pi">, { url: string; color: string }> = {
  "claude-code": { url: claude, color: "#D97757" },
  codex: { url: codex, color: "currentColor" },
  opencode: { url: opencode, color: "currentColor" },
};

/** Pi's cells on a 4 by 4 grid, by colour (pi-logo.ts). */
const PI_CELLS: [string, [number, number][]][] = [
  ["rgb(228,138,122)", [[0, 0], [1, 0], [2, 0], [2, 1]]],
  ["rgb(79,142,179)", [[0, 1], [0, 2], [1, 2], [0, 3]]],
  ["rgb(234,182,93)", [[3, 2], [3, 3]]],
];

export function AgentMark({ program, size = 14, className = "" }: { program: Program; size?: number; className?: string }) {
  const label = PROGRAM_NAME[program];

  if (program === "pi") {
    return (
      <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 4 4" className={`shrink-0 ${className}`}>
        {PI_CELLS.flatMap(([fill, cells]) => cells.map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width={1} height={1} fill={fill} />))}
      </svg>
    );
  }

  const m = MASK[program];

  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-block shrink-0 ${className}`}
      style={{ width: size, height: size, background: m.color, mask: `url(${m.url}) center / contain no-repeat`, WebkitMask: `url(${m.url}) center / contain no-repeat` }}
    />
  );
}

/** Any other agent's mark (a future program): the generic glyph, in the text colour. */
export const OtherMark = ({ size = 14 }: { size?: number }) => (
  <span aria-hidden="true" className="inline-block shrink-0" style={{ width: size, height: size, background: "currentColor", mask: `url(${custom}) center / contain no-repeat`, WebkitMask: `url(${custom}) center / contain no-repeat` }} />
);

/**
 * A model's display name, by a fixed rule (DETERMINISM.md row 5): Claude's ids as "Opus 5.5", GPT's as "GPT-5.5";
 * any other id as recorded.
 */
export function modelName(id: string): string {
  const claudeId = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?(?:-\d{8})?$/.exec(id);

  const [, family = "", major = "", minor] = claudeId ?? [];

  if (claudeId) return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;

  const gpt = /^gpt-(.+)$/i.exec(id);

  return gpt ? `GPT-${gpt[1]}` : id;
}

/** "Claude Code, Opus 5.5 +1": the model with the most answers (the server's order), and how many others answered. */
export function agentAndModel(program: Program, models: readonly { model: string }[]): string {
  const first = models[0];

  if (!first) return PROGRAM_NAME[program];

  return `${PROGRAM_NAME[program]}, ${modelName(first.model)}${models.length > 1 ? ` +${models.length - 1}` : ""}`;
}
