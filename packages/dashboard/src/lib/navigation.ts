export function activeNavigationUrl(
  asPath: string,
  hrefs: readonly string[],
): string | undefined {
  const current = new URL(asPath, "http://dashboard.local");
  const currentPath = current.pathname.replace(/\/$/, "") || "/";
  let selected: string | undefined;
  let selectedPathLength = -1;
  let selectedQueryCount = -1;

  for (const href of hrefs) {
    const target = new URL(href, current.origin);
    if (target.origin !== current.origin) continue;
    const targetPath = target.pathname.replace(/\/$/, "") || "/";
    if (
      currentPath !== targetPath &&
      (targetPath === "/" || !currentPath.startsWith(`${targetPath}/`))
    ) {
      continue;
    }

    let queryCount = 0;
    let matches = true;
    for (const [key, value] of target.searchParams) {
      if (current.searchParams.get(key) !== value) {
        matches = false;
        break;
      }
      queryCount += 1;
    }
    if (!matches) continue;
    if (
      targetPath.length > selectedPathLength ||
      (targetPath.length === selectedPathLength &&
        queryCount > selectedQueryCount)
    ) {
      selected = href;
      selectedPathLength = targetPath.length;
      selectedQueryCount = queryCount;
    }
  }

  return selected;
}
