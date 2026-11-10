/**
 * git-path.ts -- decode the C-style quoted paths git prints without `-z`.
 *
 * `pi.exec` decodes each stdout chunk as UTF-8 on its own, so a multibyte
 * character split across two chunks becomes U+FFFD. With `core.quotePath=true`
 * git escapes every non-ASCII byte (and control characters, `"` and `\`) as
 * `"..."` with octal escapes, so a listing read without `-z` is pure ASCII and
 * survives any chunking; this module turns it back into the real path.
 */

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Args that make `git` quote every non-ASCII path byte; put them before the subcommand. */
export const QUOTE_PATH_ARGS = ["-c", "core.quotePath=true"];

/**
 * Decode one path as git prints it: a plain name is returned as is, a `"..."` name is
 * unescaped to bytes and decoded as UTF-8. Throws on anything that cannot name a file
 * as a JS string: raw non-ASCII (the listing was not quoted, so it may be mis-decoded),
 * a malformed escape, or bytes that are not valid UTF-8.
 */
export function unquoteGitPath(text: string): string {
  const quoted = text.length >= 2 && text.startsWith('"') && text.endsWith('"');
  const body = quoted ? text.slice(1, -1) : text;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) > 0x7f) throw new Error(`git printed a non-ASCII path unquoted (${JSON.stringify(text)}); it may be mis-decoded`);
  }
  if (!quoted) return text;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i);
    if (char === '"') throw new Error(`malformed quoted git path ${JSON.stringify(text)}`);
    if (char !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body.charAt(i + 1);
    const octal = /^[0-3][0-7]{2}$/.test(body.slice(i + 1, i + 4)) ? body.slice(i + 1, i + 4) : undefined;
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next] as number);
      i += 1;
    } else {
      throw new Error(`malformed escape in quoted git path ${JSON.stringify(text)}`);
    }
  }
  try {
    return UTF8.decode(Uint8Array.from(bytes));
  } catch {
    throw new Error(`git path ${JSON.stringify(text)} is not valid UTF-8 and cannot be inspected`);
  }
}
