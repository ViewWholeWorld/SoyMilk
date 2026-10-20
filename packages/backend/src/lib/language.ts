/** 显式语言声明优先；未声明时避免把含汉字的日文、韩文误当成中文。 */
export function isChinese(language: string | null | undefined, sample: string): boolean {
  const declared = language?.trim().toLowerCase().replaceAll("_", "-");
  if (declared && !["und", "unknown", "auto"].includes(declared)) return /^zh(?:-|$)/.test(declared);
  return /\p{Script=Han}/u.test(sample) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sample);
}
