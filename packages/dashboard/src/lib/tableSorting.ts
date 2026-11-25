export type InventorySortDirection = "asc" | "desc";
export type InventorySortValue = string | number | null | undefined;

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function missing(value: InventorySortValue): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value))
  );
}

/** Unknown values stay last in either direction; zero is a real value. */
export function compareInventoryValues(
  left: InventorySortValue,
  right: InventorySortValue,
  direction: InventorySortDirection,
): number {
  if (missing(left)) return missing(right) ? 0 : 1;
  if (missing(right)) return -1;
  const order =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : collator.compare(String(left), String(right));
  return direction === "asc" ? order : -order;
}
