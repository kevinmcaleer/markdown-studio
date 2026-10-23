import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "./router";

/** An <a> that changes page without a reload (modifier-clicks still open a tab). */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(href);
  }
  return <a href={href} onClick={handle} {...rest} />;
}
