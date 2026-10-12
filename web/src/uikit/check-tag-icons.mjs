#!/usr/bin/env node
// Fails when a non-Ant icon sits inside an antd Tag without `className="anticon"`.
//
// WHY THIS EXISTS. Ant lays a tag out around `.anticon`: the gap between a
// glyph and its label is `> .anticon + span`, and the global `.anticon` reset is
// what centres a glyph on the text. Our icons come from Phosphor and Iconify, so
// a bare one inside a Tag gets neither. The environment tags on the promote
// panel shipped that way, the glyph hard against the word, and nothing failed:
// TypeScript cannot see a class name. The icons made in src/icons.tsx,
// uikit/icons.tsx, tablekit/icons.tsx and ScannerMark already carry the class.
// What does not is the `Icon` wrapper from components/icons.tsx and any glyph
// imported straight from `~icons/...` or `@iconify-react/...`.
//
// It checks what it can see in the source: those two kinds of element written
// inside a <Tag> (the `icon` prop or the children). An icon passed in through a
// variable is not followed.
//
//   node src/uikit/check-tag-icons.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** End of the JSX opening tag that starts at `i`, skipping `{...}` and strings. */
function openingEnd(src, i) {
  let depth = 0;
  let quote = null;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === "\\") j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return { end: j + 1, selfClosing: src[j - 1] === "/" };
  }
  return { end: src.length, selfClosing: true };
}

/** The source of one <Name ...>...</Name> element, opening tag included. */
function elementSource(src, start, name) {
  const open = openingEnd(src, start);
  if (open.selfClosing) return src.slice(start, open.end);
  const opener = new RegExp(`<${name.replace(".", "\\.")}(?=[\\s>/])`, "g");
  const closer = `</${name}>`;
  let depth = 1;
  let at = open.end;
  while (depth > 0) {
    opener.lastIndex = at;
    const nextOpen = opener.exec(src);
    const nextClose = src.indexOf(closer, at);
    if (nextClose < 0) return src.slice(start);
    if (nextOpen && nextOpen.index < nextClose) {
      const inner = openingEnd(src, nextOpen.index);
      if (!inner.selfClosing) depth++;
      at = inner.end;
    } else {
      depth--;
      at = nextClose + closer.length;
    }
  }
  return src.slice(start, at);
}

const failures = [];
for (const file of walk(root)) {
  const src = readFileSync(file, "utf8");
  const tags = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']antd["']/g)) {
    for (const spec of m[1].split(",")) {
      const [imported, local] = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (imported === "Tag") tags.add(local ?? imported);
    }
  }
  if (tags.size === 0) continue;

  const bare = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/icons["']/g)) {
    for (const spec of m[1].split(",")) {
      const [imported, local] = spec.trim().split(/\s+as\s+/);
      if (imported === "Icon") bare.add(local ?? imported);
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s*["'](?:~icons\/|@iconify-react\/)[^"']+["']/g)) {
    bare.add(m[1]);
  }
  if (bare.size === 0) continue;

  for (const tag of tags) {
    for (const m of src.matchAll(new RegExp(`<${tag}(?:\\.CheckableTag)?(?=[\\s>/])`, "g"))) {
      const name = m[0].slice(1);
      const body = elementSource(src, m.index, name);
      for (const icon of bare) {
        for (const use of body.matchAll(new RegExp(`<${icon}(?=[\\s>/])`, "g"))) {
          const attrs = body.slice(use.index, openingEnd(body, use.index).end);
          if (/\banticon\b/.test(attrs)) continue;
          const line = src.slice(0, m.index + use.index).split("\n").length;
          failures.push(`${relative(root, file)}:${line}: <${icon}> inside <${name}>`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('A non-Ant icon inside an antd Tag must carry className="anticon".\n');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("check-tag-icons: every icon inside a Tag is an anticon.");
