export function validateRegexPattern(pattern: string): { valid: boolean; error: string | null } {
  try {
    // 仅校验语法是否合法；实际匹配逻辑由服务端/调用方处理。
    new RegExp(pattern);
    return { valid: true, error: null };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid regular expression",
    };
  }
}
