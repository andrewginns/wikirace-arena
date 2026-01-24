export function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;

  const asInt = Math.floor(parsed);
  return asInt > 0 ? asInt : null;
}

export function parseOptionalPositiveInt(
  value: string,
  blank: "null"
): number | null;
export function parseOptionalPositiveInt(
  value: string,
  blank: "undefined"
): number | undefined;
export function parseOptionalPositiveInt(
  value: string,
  blank: "null" | "undefined"
) {
  const parsed = parsePositiveInt(value);
  if (parsed !== null) return parsed;
  return blank === "null" ? null : undefined;
}

