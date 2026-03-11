export interface MarkdownToken {
  type: "heading" | "listItem" | "paragraph";
  raw: string;
  text: string;
  depth?: number;
}

export interface MarkdownSection {
  heading: string | null;
  depth: number;
  items: string[];
  paragraphs: string[];
}

export interface ParsedMarkdownDocument {
  tokens: MarkdownToken[];
  sections: MarkdownSection[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripMarkdown(value: string): string {
  return collapseWhitespace(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, "")
      .replace(/^[-+*]\s+/, "")
      .replace(/^\d+\.\s+/, ""),
  );
}

export function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const tokens: MarkdownToken[] = [];
  const sections: MarkdownSection[] = [];
  let currentSection: MarkdownSection = {
    heading: null,
    depth: 0,
    items: [],
    paragraphs: [],
  };
  let paragraphLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const raw = paragraphLines.join(" ").trim();
    const text = stripMarkdown(raw);

    if (text) {
      tokens.push({
        type: "paragraph",
        raw,
        text,
      });
      currentSection.paragraphs.push(text);
    }

    paragraphLines = [];
  };

  const pushSection = () => {
    if (currentSection.heading || currentSection.items.length > 0 || currentSection.paragraphs.length > 0) {
      sections.push(currentSection);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      flushParagraph();
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushParagraph();
      pushSection();
      const depth = headingMatch[1].length;
      const raw = headingMatch[2].trim();
      const text = stripMarkdown(raw);

      tokens.push({
        type: "heading",
        raw,
        text,
        depth,
      });
      currentSection = {
        heading: text,
        depth,
        items: [],
        paragraphs: [],
      };
      continue;
    }

    const listMatch = trimmed.match(/^([-+*]|\d+\.)\s+(.+)$/);

    if (listMatch) {
      flushParagraph();
      const raw = listMatch[2].trim();
      const text = stripMarkdown(raw);

      if (text) {
        tokens.push({
          type: "listItem",
          raw,
          text,
        });
        currentSection.items.push(text);
      }
      continue;
    }

    paragraphLines.push(trimmed.replace(/^>\s?/, ""));
  }

  flushParagraph();
  pushSection();

  return {
    tokens,
    sections,
  };
}
