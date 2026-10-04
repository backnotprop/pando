// The end of a paged list (design review, 2026-10-03: no infinite scroll): a
// quiet "Older" that loads one more page in place, then a line saying so.
import { lnk } from "./controls";

export function Older({ more, loading, load, none }: { more: boolean; loading: boolean; load: () => void; none: string }) {
  if (!more) return <p className="py-2.5 text-[13.5px] text-ash">{none}</p>;

  return (
    <p className="py-2.5 text-[13.5px]">
      <button type="button" className={lnk} disabled={loading} onClick={load}>
        Older
      </button>
    </p>
  );
}
