export function billedValue(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function mergeTargetValue(value: string, currentStoryId: number | null): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const target = Number(normalized);
  return Number.isSafeInteger(target) && target > 0 && target !== currentStoryId ? target : null;
}
