/**
 * Upload validation for VPS bot strategies.
 *
 * WHAT THIS IS
 * ------------
 * A structural, dependency-free gate that runs BEFORE anything is written to
 * disk. It answers "is this a plausible, safe Blockly strategy document of an
 * acceptable size?" - not "does every block exist?".
 *
 * Full semantic validation is performed by the existing generator itself: the
 * shared runtime parses the XML into a headless Blockly workspace and generates
 * the DBot source before the strategy can execute. A malformed document
 * therefore fails there too, and never executes as arbitrary JavaScript.
 *
 * WHAT IT DEFENDS AGAINST
 * -----------------------
 *   - oversized uploads (memory / disk pressure on a 1 GB host),
 *   - XXE and entity-expansion attacks (`<!DOCTYPE`, `<!ENTITY`),
 *   - script-ish content smuggled into a "strategy" (`<script`, `javascript:`),
 *   - control characters / NUL bytes that corrupt downstream tooling,
 *   - non-XML payloads masquerading as strategies.
 */

/** Hard upper bound on an uploaded strategy. The largest shipped strategy is ~79 KiB. */
export const MAX_XML_BYTES = 512 * 1024;

/** Human label bound; the label is never used to build a path. */
export const MAX_NAME_LENGTH = 60;

/** Unicode controls are allowed only for tab, LF and CR. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Conservative label charset: printable, no path or shell significance. */
const NAME_PATTERN = /^[\w .'"()&+:/@#-]{1,60}$/;

export type ValidationFailure = { ok: false; code: string; message: string };
export type NameValidation = { ok: true; name: string } | ValidationFailure;
export type XmlValidation = { ok: true; xml: string } | ValidationFailure;

/** Validates the bot's display name. It is a label only - never a path segment. */
export function validateBotName(raw: unknown): NameValidation {
  if (typeof raw !== "string") return { ok: false, code: "invalid_name", message: "Bot name must be a string" };

  const name = raw.trim();
  if (name.length === 0) return { ok: false, code: "invalid_name", message: "Bot name is required" };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, code: "invalid_name", message: `Bot name must be at most ${MAX_NAME_LENGTH} characters` };
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, code: "invalid_name", message: "Bot name must not contain control characters" };
  }
  if (name.includes("..") || name.includes("\\")) {
    return { ok: false, code: "invalid_name", message: "Bot name must not contain path separators" };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, code: "invalid_name", message: "Bot name contains unsupported characters" };
  }
  return { ok: true, name };
}

/**
 * Validates an uploaded strategy document.
 *
 * The tag-balance pass is a small hand-rolled scanner rather than a full XML
 * parser: it needs to be predictable and allocation-light, and every document it
 * accepts is subsequently parsed by the real Blockly loader.
 */
export function validateStrategyXml(raw: unknown): XmlValidation {
  if (typeof raw !== "string") return { ok: false, code: "invalid_xml", message: "Strategy body must be text" };

  const xml = raw.trim();
  if (xml.length === 0) return { ok: false, code: "invalid_xml", message: "Strategy body is empty" };

  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
    return { ok: false, code: "xml_too_large", message: `Strategy exceeds the ${MAX_XML_BYTES} byte limit` };
  }

  if (CONTROL_CHARS.test(xml)) {
    return { ok: false, code: "invalid_xml", message: "Strategy contains control characters" };
  }

  // XXE / entity expansion: a strategy document never legitimately declares a DTD.
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    return { ok: false, code: "invalid_xml", message: "Strategy must not declare DOCTYPE or ENTITY" };
  }

  // Defence in depth: a strategy is data, never markup a browser executes.
  if (/<script/i.test(xml) || /javascript:/i.test(xml)) {
    return { ok: false, code: "invalid_xml", message: "Strategy must not contain script content" };
  }

  if (!xml.startsWith("<")) {
    return { ok: false, code: "invalid_xml", message: "Strategy must start with an XML element" };
  }

  const balance = checkTagBalance(xml);
  if (!balance.ok) return balance;

  if (balance.rootTag === null || balance.rootTag.toLowerCase() !== "xml") {
    return { ok: false, code: "invalid_xml", message: "Strategy root element must be <xml>" };
  }

  if (!/<block[\s/>]/.test(xml)) {
    return { ok: false, code: "invalid_xml", message: "Strategy contains no <block> elements" };
  }

  return { ok: true, xml };
}

type BalanceResult = { ok: true; rootTag: string | null } | ValidationFailure;

/**
 * Scans for unbalanced tags.
 *
 * Handles comments, CDATA, self-closing elements and attributes containing `>`,
 * which is all a Blockly document contains.
 */
function checkTagBalance(xml: string): BalanceResult {
  const stack: string[] = [];
  let rootTag: string | null = null;
  let index = 0;

  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open < 0) break;
    index = open;

    if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end < 0) return { ok: false, code: "invalid_xml", message: "Unterminated XML comment" };
      index = end + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end < 0) return { ok: false, code: "invalid_xml", message: "Unterminated CDATA section" };
      index = end + 3;
      continue;
    }

    if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index + 2);
      if (end < 0) return { ok: false, code: "invalid_xml", message: "Unterminated processing instruction" };
      index = end + 2;
      continue;
    }

    const close = xml.indexOf(">", index + 1);
    if (close < 0) return { ok: false, code: "invalid_xml", message: "Unterminated XML element" };

    const inner = xml.slice(index + 1, close).trim();

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      const expected = stack.pop();
      if (expected === undefined || expected !== name) {
        return { ok: false, code: "invalid_xml", message: `Mismatched closing tag </${name}>` };
      }
    } else {
      const selfClosing = inner.endsWith("/");
      const withoutSlash = selfClosing ? inner.slice(0, -1).trim() : inner;
      const name = withoutSlash.split(/[\s/>]/, 1)[0];
      if (name === "") return { ok: false, code: "invalid_xml", message: "Malformed XML element" };

      if (stack.length === 0) {
        if (rootTag !== null) {
          return { ok: false, code: "invalid_xml", message: "Strategy must have exactly one root element" };
        }
        rootTag = name;
      }
      if (!selfClosing) stack.push(name);
    }

    index = close + 1;
  }

  if (stack.length > 0) {
    return { ok: false, code: "invalid_xml", message: `Unclosed XML element <${stack[stack.length - 1]}>` };
  }
  return { ok: true, rootTag };
}
