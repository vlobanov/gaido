import fs from 'node:fs';
import path from 'node:path';
import {
  MESSAGE_FILENAME,
  type CoderMessage,
  type CoderMessageKind,
} from '@gaido/core';

const KINDS: readonly CoderMessageKind[] = ['question', 'limitation', 'note'];

/**
 * Read and parse `MESSAGE.md` from the worktree root. Returns null when the
 * file is absent or unreadable.
 *
 * Parsing is intentionally lenient: a coder that bothered to write the file
 * should have its message survive even if the frontmatter is malformed.
 * Missing `producedArtifact` defaults to false (the common case — coder is
 * choosing to talk instead of render). Missing/unknown `kind` defaults to
 * 'note'. No frontmatter at all → whole file is treated as the body.
 */
export function readCoderMessage(workdir: string): CoderMessage | null {
  const filePath = path.join(workdir, MESSAGE_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseCoderMessage(raw);
}

export function parseCoderMessage(raw: string): CoderMessage {
  const text = raw.replace(/^﻿/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let frontmatter: Record<string, string> = {};
  let body = text;
  if (match) {
    frontmatter = parseFrontmatter(match[1] ?? '');
    body = match[2] ?? '';
  }

  const producedArtifact = parseBool(frontmatter['producedArtifact']) ?? false;
  const kindRaw = (frontmatter['kind'] ?? '').toLowerCase();
  const kind: CoderMessageKind = (KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as CoderMessageKind)
    : 'note';

  return { producedArtifact, kind, body: body.trim() };
}

function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseBool(value: string | undefined): boolean | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return null;
}
