/** Serialize for dotenv + dotenv-expand consumers such as Next.js. Never evaluate values. */
export function serializeEnvironment(values: Readonly<Record<string, unknown>>): string {
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`Environment key "${key}" cannot be represented by this dotenv exporter.`);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof text !== 'string' || text.includes('\0'))
      throw new Error(`Environment key "${key}" has an unexportable value.`);
    const escaped = text.replaceAll('$', '\\$');
    // Literal quotes preserve backslash-n sequences; a trailing backslash escapes the closing quote.
    if (!text.endsWith('\\') && !text.includes('\r')) {
      if (!text.includes("'")) return `${key}='${escaped}'`;
      if (!text.includes('`')) return `${key}=\`${escaped}\``;
    }
    if (!text.endsWith('\\') && !text.includes('"') && !/\\[nr]/.test(text)) {
      return `${key}="${escaped.replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`;
    }
    // An unquoted dotenv value preserves trailing backslashes and mixed interior quotes.
    // A leading delimiter, comment, line break, or outer whitespace would change parsing.
    if (text.trim() === text && !/^["'`]/.test(text) && !/[\r\n\u2028\u2029#]/.test(text)) {
      return `${key}=${escaped}`;
    }
    throw new Error(
      `Environment key "${key}" cannot be exported losslessly with dotenv quoting. Use Varlock runtime injection for this value.`,
    );
  });
  return `${lines.join('\n')}\n`;
}
