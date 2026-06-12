const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID_PATTERN = /\b0x[0-9a-f]+\b/gi;
const LONG_HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const QUOTED_STRING_PATTERN = /(['"])[^'"]*\1/g;
const NUMBER_PATTERN = /\d+/g;

export function normalizeExceptionMessage(message: string): string {
  let normalized = message;
  normalized = normalized.replace(UUID_PATTERN, '<UUID>');
  normalized = normalized.replace(HEX_ID_PATTERN, '<HEX>');
  normalized = normalized.replace(LONG_HEX_PATTERN, '<HEX>');
  normalized = normalized.replace(QUOTED_STRING_PATTERN, '<STR>');
  normalized = normalized.replace(NUMBER_PATTERN, '<NUM>');
  return normalized;
}
