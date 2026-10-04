// The prototype's menu, on Base UI's Menu (keyboard, focus, dismissal). Opening
// is the one small motion: a short fade and scale from the trigger.
import { Menu } from "@base-ui/react/menu";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { AppLink } from "./paths";
import { EXACT } from "./TabBar";

/** Where a menu row goes: a monorepo, the home (narrowed or not), or Your machines. */
export type MenuTarget = AppLink | { to: "/"; search?: { in: string } } | { to: "/settings/machines" };

export const menuItem =
  "flex h-8 w-full cursor-pointer items-center gap-3 rounded-md px-2.5 text-left text-[13.5px] text-bark-dim outline-none data-highlighted:bg-pop-hi data-highlighted:text-bark data-current:bg-pop-hi data-current:text-bark";

export function MenuPopup({ children, align = "start", offset = 6 }: { children: ReactNode; align?: "start" | "end"; offset?: number }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={offset} align={align} className="z-10 outline-none">
        <Menu.Popup className="min-w-[260px] origin-(--transform-origin) rounded-[10px] border border-rootline bg-pop p-1.5 shadow-pop outline-none transition-[opacity,scale] duration-150 ease-pando data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-opacity">
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export const menuHeading = "px-2.5 pt-2 pb-1.5 text-[12px] text-ash";

export const MenuHeading = ({ children }: { children: ReactNode }) => <div className={menuHeading}>{children}</div>;

export const MenuRule = () => <Menu.Separator className="mx-1 my-1.5 border-t border-rootline" />;

/** A menu row that navigates within the app. */
export function MenuLink({ link, current = false, children }: { link: MenuTarget; current?: boolean; children: ReactNode }) {
  return (
    <Menu.Item render={<Link {...link} activeOptions={EXACT} />} data-current={current || undefined} className={menuItem}>
      {children}
    </Menu.Item>
  );
}
