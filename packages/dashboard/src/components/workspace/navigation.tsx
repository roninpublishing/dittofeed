import { CompletionStatus } from "isomorphic-lib/src/types";
import Link from "next/link";
import { useRouter } from "next/router";
import { ComponentProps, createContext, forwardRef, useContext } from "react";

import { useAppStorePick } from "../../lib/appStore";
import { parseWorkspaceRoute } from "../../lib/workspaceRoutes";

// This boundary comes from the authenticated server page, not the destination URL.
export const WorkspaceNavigationContext = createContext<string | null>(null);

export function useWorkspaceNavigation() {
  const router = useRouter();
  const authorizedWorkspaceId = useContext(WorkspaceNavigationContext);
  const { workspace } = useAppStorePick(["workspace"]);
  const sameWorkspace =
    authorizedWorkspaceId !== null &&
    workspace.type === CompletionStatus.Successful &&
    workspace.value.id === authorizedWorkspaceId;

  const canShallow = (href: ComponentProps<typeof Link>["href"]) => {
    if (
      !sameWorkspace ||
      !router.isReady ||
      router.pathname !== "/workspace/[[...section]]" ||
      typeof href !== "string" ||
      !href.startsWith("/") ||
      href.startsWith("//")
    )
      return false;
    const target = new URL(href, "http://dashboard.local");
    if (
      target.origin !== "http://dashboard.local" ||
      target.search ||
      (target.pathname !== "/workspace" &&
        !target.pathname.startsWith("/workspace/"))
    )
      return false;
    const sections = target.pathname.split("/").slice(2);
    if (sections.at(-1) === "") sections.pop();
    return parseWorkspaceRoute(sections) !== null;
  };

  return {
    canShallow,
    push: (href: string, options?: { replace?: boolean; scroll?: boolean }) =>
      router[options?.replace ? "replace" : "push"](href, undefined, {
        scroll: options?.scroll,
        shallow: canShallow(href),
      }),
  };
}

const WorkspaceLink = forwardRef<
  HTMLAnchorElement,
  ComponentProps<typeof Link>
>(function WorkspaceLink(
  {
    href,
    shallow,
    prefetch,
    as,
    replace,
    scroll,
    locale,
    legacyBehavior,
    passHref,
    onClick,
    ...props
  },
  ref,
) {
  const router = useRouter();
  const { canShallow, push } = useWorkspaceNavigation();
  const withinWorkspace =
    canShallow(href) &&
    shallow !== false &&
    as === undefined &&
    locale === undefined &&
    !legacyBehavior;
  // Pages Router prefetches on hover even with prefetch=false.
  // These routes already share their page bundle; a native anchor avoids SSR prefetch.
  if (withinWorkspace && typeof href === "string")
    return (
      <a
        {...props}
        ref={ref}
        href={`${router.basePath}${href}`}
        onClick={(event) => {
          onClick?.(event);
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            (event.currentTarget.target &&
              event.currentTarget.target !== "_self") ||
            event.currentTarget.hasAttribute("download")
          )
            return;
          event.preventDefault();
          void push(href, { replace, scroll });
        }}
      >
        {props.children}
      </a>
    );
  return (
    <Link
      {...props}
      as={as}
      replace={replace}
      scroll={scroll}
      locale={locale}
      legacyBehavior={legacyBehavior}
      passHref={passHref}
      onClick={onClick}
      ref={ref}
      href={href}
      shallow={withinWorkspace}
      prefetch={withinWorkspace ? false : prefetch}
    />
  );
});

export default WorkspaceLink;
