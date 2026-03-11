import "server-only";

import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseMarkdownDocument } from "@/lib/markdown";
import type {
  AssistantIdentityProfile,
  GeneratedIdentityFile,
  IdentitySourceFile,
  IdentitySourceKind,
  OwnerIdentityProfile,
  SyncIdentityOptions,
  SyncIdentityResult,
} from "@/types";

const parserVersion = "2026-03-11.1";
const defaultOutputFileName = "identity.json";

const sourceDefinitions: Array<{ kind: IdentitySourceKind; fileName: string }> = [
  { kind: "identity", fileName: "IDENTITY.md" },
  { kind: "soul", fileName: "SOUL.md" },
  { kind: "user", fileName: "USER.md" },
  { kind: "agents", fileName: "AGENTS.md" },
  { kind: "tools", fileName: "TOOLS.md" },
];

interface LoadedSourceFile extends IdentitySourceFile {
  content: string;
}

interface FieldValues {
  name: string[];
  description: string[];
  role: string[];
  creature: string[];
  vibe: string[];
  emoji: string[];
  skills: string[];
  capabilities: string[];
  preferredName: string[];
  timezone: string[];
  notes: string[];
}

function createEmptyFieldValues(): FieldValues {
  return {
    name: [],
    description: [],
    role: [],
    creature: [],
    vibe: [],
    emoji: [],
    skills: [],
    capabilities: [],
    preferredName: [],
    timezone: [],
    notes: [],
  };
}

function withTrailingLineBreak(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function toSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeValue(value);

    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.toLocaleLowerCase("zh-CN");

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    result.push(normalized);
  }

  return result;
}

function normalizeValue(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();

  return /^[-*_]{3,}$/.test(normalized) ? "" : normalized;
}

function firstValue(...groups: string[][]): string | null {
  for (const group of groups) {
    for (const value of group) {
      const normalized = normalizeValue(value);

      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function splitMultiValue(value: string): string[] {
  return value
    .split(/[\n,，、/｜|]/)
    .map((item) => normalizeValue(item))
    .filter(Boolean);
}

function normalizeLabel(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function matchLabeledField(text: string): { field: keyof FieldValues; value: string } | null {
  const match = text.match(/^([^:：]{1,40})[:：]\s*(.+)$/);

  if (!match) {
    return null;
  }

  const label = normalizeLabel(match[1]);
  const value = normalizeValue(match[2]);

  if (!value) {
    return null;
  }

  const labelMap: Record<string, keyof FieldValues> = {
    name: "name",
    名称: "name",
    名字: "name",
    description: "description",
    描述: "description",
    简介: "description",
    role: "role",
    角色: "role",
    creature: "creature",
    物种: "creature",
    类型: "creature",
    vibe: "vibe",
    风格: "vibe",
    气质: "vibe",
    氛围: "vibe",
    emoji: "emoji",
    表情: "emoji",
    skills: "skills",
    skill: "skills",
    技能: "skills",
    能力: "capabilities",
    capabilities: "capabilities",
    notes: "notes",
    note: "notes",
    备注: "notes",
    whattocallthem: "preferredName",
    preferredname: "preferredName",
    称呼: "preferredName",
    timezone: "timezone",
    时区: "timezone",
  };

  const field = labelMap[label];

  if (!field) {
    return null;
  }

  return { field, value };
}

function getSectionTexts(content: string, headingNames: string[]): string[] {
  const document = parseMarkdownDocument(content);
  const normalizedHeadingNames = headingNames.map((heading) => normalizeLabel(heading));

  return document.sections
    .filter((section) => {
      if (!section.heading) {
        return false;
      }

      return normalizedHeadingNames.includes(normalizeLabel(section.heading));
    })
    .flatMap((section) => [...section.paragraphs, ...section.items]);
}

function collectFieldValues(content: string): FieldValues {
  const document = parseMarkdownDocument(content);
  const values = createEmptyFieldValues();

  for (const token of document.tokens) {
    if (token.type !== "listItem" && token.type !== "paragraph") {
      continue;
    }

    const matched = matchLabeledField(token.text);

    if (!matched) {
      continue;
    }

    if (matched.field === "skills" || matched.field === "capabilities") {
      values[matched.field].push(...splitMultiValue(matched.value));
      continue;
    }

    values[matched.field].push(matched.value);
  }

  return values;
}

function extractIdentityProfile(sourceMap: Map<IdentitySourceKind, LoadedSourceFile>): {
  assistant: AssistantIdentityProfile;
  owner: OwnerIdentityProfile;
} {
  const identityValues = collectFieldValues(sourceMap.get("identity")?.content ?? "");
  const soulValues = collectFieldValues(sourceMap.get("soul")?.content ?? "");
  const userValues = collectFieldValues(sourceMap.get("user")?.content ?? "");

  const identityDocument = parseMarkdownDocument(sourceMap.get("identity")?.content ?? "");
  const userDocument = parseMarkdownDocument(sourceMap.get("user")?.content ?? "");
  const soulContent = sourceMap.get("soul")?.content ?? "";

  const identityParagraphs = identityDocument.tokens
    .filter((token) => token.type === "paragraph")
    .map((token) => token.text)
    .filter((text) => !matchLabeledField(text));
  const userParagraphs = userDocument.tokens
    .filter((token) => token.type === "paragraph")
    .map((token) => token.text)
    .filter((text) => !matchLabeledField(text));

  const soulPrinciples = getSectionTexts(soulContent, ["Core Truths", "核心原则"]);
  const soulBoundaries = getSectionTexts(soulContent, ["Boundaries", "边界"]);
  const soulVibe = getSectionTexts(soulContent, ["Vibe", "风格", "气质"]);

  const assistantNotes = uniqueValues([
    ...identityValues.notes,
    ...identityParagraphs,
  ]);
  const skills = uniqueValues([
    ...identityValues.skills,
    ...identityValues.capabilities,
  ]);
  const capabilities = uniqueValues([
    ...identityValues.capabilities,
    ...identityValues.skills,
  ]);

  const assistant: AssistantIdentityProfile = {
    name: firstValue(identityValues.name, soulValues.name),
    description: firstValue(identityValues.description, assistantNotes),
    role: firstValue(identityValues.role, identityValues.creature),
    creature: firstValue(identityValues.creature, identityValues.role),
    vibe: firstValue(identityValues.vibe, soulVibe, soulValues.vibe),
    emoji: firstValue(identityValues.emoji),
    skills,
    capabilities: capabilities.length > 0 ? capabilities : skills,
    principles: uniqueValues(soulPrinciples),
    boundaries: uniqueValues(soulBoundaries),
    notes: assistantNotes,
  };

  const owner: OwnerIdentityProfile = {
    name: firstValue(userValues.name),
    preferredName: firstValue(userValues.preferredName),
    timezone: firstValue(userValues.timezone),
    notes: uniqueValues([...userValues.notes, ...userParagraphs]),
  };

  return {
    assistant,
    owner,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readSourceFile(rootDir: string, kind: IdentitySourceKind, fileName: string): Promise<LoadedSourceFile> {
  const filePath = path.join(rootDir, fileName);

  if (!(await pathExists(filePath))) {
    return {
      kind,
      fileName,
      path: filePath,
      exists: false,
      size: 0,
      sha256: null,
      updatedAt: null,
      content: "",
    };
  }

  try {
    const [fileStat, content] = await Promise.all([stat(filePath), readFile(filePath, "utf8")]);

    return {
      kind,
      fileName,
      path: filePath,
      exists: true,
      size: fileStat.size,
      sha256: toSha256(content),
      updatedAt: fileStat.mtime.toISOString(),
      content,
    };
  } catch (error) {
    throw new Error(
      error instanceof Error ? `读取身份文件失败（${fileName}）：${error.message}` : `读取身份文件失败（${fileName}）。`,
    );
  }
}

function buildSourceFingerprint(sources: IdentitySourceFile[]): string {
  return toSha256(
    JSON.stringify({
      parserVersion,
      sources: sources.map((source) => ({
        fileName: source.fileName,
        sha256: source.sha256,
        size: source.size,
      })),
    }),
  );
}

async function readExistingIdentity(outputPath: string): Promise<GeneratedIdentityFile | null> {
  if (!(await pathExists(outputPath))) {
    return null;
  }

  try {
    const content = await readFile(outputPath, "utf8");
    return JSON.parse(content) as GeneratedIdentityFile;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw new Error(
      error instanceof Error ? `读取已生成身份信息失败：${error.message}` : "读取已生成身份信息失败。",
    );
  }
}

function assertHasIdentityFiles(sources: LoadedSourceFile[]) {
  const existingSources = sources.filter((source) => source.exists);

  if (existingSources.length === 0) {
    throw new Error("未发现可解析的身份文件，请至少提供 IDENTITY.md、SOUL.md 或 USER.md。");
  }
}

export async function syncIdentityFile(options: SyncIdentityOptions): Promise<SyncIdentityResult> {
  const rootDir = path.resolve(options.rootDir);
  const outputPath = path.join(rootDir, options.outputFileName ?? defaultOutputFileName);

  try {
    const sources = await Promise.all(
      sourceDefinitions.map((definition) => readSourceFile(rootDir, definition.kind, definition.fileName)),
    );

    assertHasIdentityFiles(sources);

    const sourceMap = new Map<IdentitySourceKind, LoadedSourceFile>(
      sources.filter((source) => source.exists).map((source) => [source.kind, source]),
    );
    const existingIdentity = await readExistingIdentity(outputPath);
    const normalizedSources: IdentitySourceFile[] = sources.map((source) => ({
      kind: source.kind,
      fileName: source.fileName,
      path: source.path,
      exists: source.exists,
      size: source.size,
      sha256: source.sha256,
      updatedAt: source.updatedAt,
    }));
    const sourceFingerprint = buildSourceFingerprint(normalizedSources);

    if (
      existingIdentity &&
      !options.force &&
      existingIdentity.parserVersion === parserVersion &&
      existingIdentity.sourceFingerprint === sourceFingerprint
    ) {
      return {
        ok: true,
        status: "unchanged",
        message: "身份信息无变化，沿用现有 identity.json。",
        identity: existingIdentity,
      };
    }

    const { assistant, owner } = extractIdentityProfile(sourceMap);
    const now = new Date().toISOString();
    const identity: GeneratedIdentityFile = {
      version: 1,
      parserVersion,
      generatedAt: now,
      sourceRoot: rootDir,
      outputPath,
      sourceFingerprint,
      assistant,
      owner,
      sources: normalizedSources,
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, withTrailingLineBreak(JSON.stringify(identity, null, 2)), "utf8");

    return {
      ok: true,
      status: existingIdentity ? "updated" : "created",
      message: existingIdentity ? "身份信息已更新。" : "身份信息已生成。",
      identity,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "身份信息同步失败。");
  }
}
