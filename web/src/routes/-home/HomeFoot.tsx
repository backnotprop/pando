// The home's quiet bottom-left: What's new, then Documentation, Your machines
// and Contact, then Status, Privacy and Terms (owner notes on the approach).
import { Link } from "@tanstack/react-router";
import { lnk } from "../../ui/controls";
import { BookIcon, ChatIcon, LaptopIcon } from "../../ui/Icons";
import { DOCS } from "../../ui/paths";

/** The latest changelog entry. The docs build will emit it as JSON; until then it is kept here. */
const WHATS_NEW = { date: "Oct 3", headline: "Merge stops if a branch changed after review", href: `${DOCS}/changelog` };

const quiet = "flex h-[30px] items-center gap-2.5 text-[13px] text-bark-dim hover:text-bark *:[svg]:size-[15px] *:[svg]:flex-none *:[svg]:text-ash";

export function HomeFoot() {
  return (
    <div className="mt-auto pt-12 phone:order-1 phone:pt-2">
      <div className="flex flex-col items-start gap-2 pb-4">
        <span className="flex items-center gap-2.5">
          <span className="inline-flex h-5 items-center rounded-full border border-rootline px-2 text-[11.5px] leading-[14px] text-bark-dim">What's new</span>
          <span className="font-mono text-[12.5px] text-ash">{WHATS_NEW.date}</span>
        </span>
        <a href={WHATS_NEW.href} className="text-[13.5px] leading-[19px] font-semibold text-bark hover:underline hover:decoration-ash hover:underline-offset-3">
          {WHATS_NEW.headline}
        </a>
        <a href={`${DOCS}/changelog`} className={`${lnk} text-[12.5px]`}>
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
      <a href={`${DOCS}/contact`} className={quiet}>
        <ChatIcon />
        Contact
      </a>
      <p className="mt-3 flex gap-4 text-[11.5px] text-ash *:hover:text-bark-dim">
        <a href={`${DOCS}/status`}>Status</a>
        <a href={`${DOCS}/privacy`}>Privacy</a>
        <a href={`${DOCS}/terms`}>Terms</a>
      </p>
    </div>
  );
}
