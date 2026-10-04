// The home's quiet bottom-left: What's new, then Documentation, Your machines
// and Contact, then Status, Privacy and Terms (owner notes on the approach).
// What's new is the docs build's newest changelog entry (site/docs, emitted
// as whats-new.json), read at runtime through /docs; while the docs site
// can't be reached, the line is hidden.
import { decodeResponse } from "@pando/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { lnk } from "../../ui/controls";
import { BookIcon, ChatIcon, LaptopIcon } from "../../ui/Icons";
import { DOCS } from "../../ui/paths";
import { refClass } from "../../ui/Ref";

/** site/docs/src/pages/whats-new.json.ts: the date (YYYY-MM-DD), the entry's headline and its link in the changelog. */
const WhatsNew = Schema.Struct({
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  headline: Schema.String.check(Schema.isNonEmpty()),
  link: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
});

const decodeWhatsNew = decodeResponse(WhatsNew);

const whatsNewQuery = queryOptions({
  queryKey: ["whats-new"],
  queryFn: async () => {
    const res = await fetch(`${DOCS}/whats-new.json`);

    if (!res.ok) throw new Error(`whats-new.json answered ${res.status}`);
    const entry = decodeWhatsNew(await res.json());

    if (Result.isFailure(entry)) throw new Error(`whats-new.json: ${entry.failure.message}`);

    return entry.success;
  },
  // The docs site caches it for 5 minutes too (site/docs/public/_headers).
  staleTime: 5 * 60_000,
  retry: false,
});

/** "2026-10-03" as "Oct 3". */
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const quiet = "flex h-[30px] items-center gap-2.5 text-[13px] text-bark-dim hover:text-bark *:[svg]:size-[15px] *:[svg]:flex-none *:[svg]:text-ash";

export function HomeFoot() {
  const { data: news } = useQuery(whatsNewQuery);

  return (
    <div className="mt-auto pt-12 phone:order-1 phone:pt-2">
      <div className="flex flex-col items-start gap-2 pb-4">
        {news && (
          <>
            {/* One quiet line, flush left with the headline and the link: no pill, no mono (owner: the labels felt off). */}
            <p className="text-[12.5px] leading-[15px] text-ash">
              <span className="text-bark-dim">What's new</span> · {shortDate(news.date)}
            </p>
            {/* The headline is set as who is in a sentence: semibold Bark, Link under the pointer (links R). */}
            <a href={news.link} className={`text-[13.5px] leading-[19px] ${refClass("person")}`}>
              {news.headline}
            </a>
          </>
        )}
        <a href={`${DOCS}/changelog/`} className={`${lnk} text-[12.5px]`}>
          Changelog
        </a>
      </div>
      <hr className="mb-2 border-t border-rule-faint" />
      <a href={DOCS} className={quiet}>
        <BookIcon />
        Documentation
      </a>
      <Link to="/settings/machines" className={quiet}>
        <LaptopIcon />
        Your machines
      </Link>
      <a href={`${DOCS}/contact/`} className={quiet}>
        <ChatIcon />
        Contact
      </a>
      <p className="mt-3 flex gap-4 text-[11.5px] text-ash *:hover:text-bark-dim">
        <a href={`${DOCS}/status/`}>Status</a>
        <a href={`${DOCS}/privacy/`}>Privacy</a>
        <a href={`${DOCS}/terms/`}>Terms</a>
      </p>
    </div>
  );
}
