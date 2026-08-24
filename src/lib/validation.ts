// Pure validation utilities. No DB imports here so this module can be used
// from client components.

// Numeric grade with at most one decimal place. "70" OK, "70.5" OK,
// "70.52" not OK. Empty string is also allowed (used to clear a grade).
export const GRADE_REGEX_SOURCE = "^\\d+(\\.\\d)?$";
export const GRADE_REGEX = new RegExp(GRADE_REGEX_SOURCE);

export function isValidGrade(s: string): boolean {
  if (s === "") return true;
  if (!GRADE_REGEX.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}
