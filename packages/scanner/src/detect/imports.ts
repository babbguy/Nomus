import { readFileSync, statSync } from 'node:fs';

export interface DetectedImport {
  file: string;
  line: number;
  sdk: string;
  language: string;
  importStatement: string;
}

interface SDKPattern {
  sdk: string;
  patterns: RegExp[];
}

const JS_TS_PATTERNS: SDKPattern[] = [
  { sdk: '@anthropic-ai/sdk', patterns: [/from\s+['"]@anthropic-ai\/sdk['"]/, /require\s*\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/] },
  { sdk: 'openai', patterns: [/from\s+['"]openai['"]/, /require\s*\(\s*['"]openai['"]\s*\)/] },
  { sdk: '@google/generative-ai', patterns: [/from\s+['"]@google\/generative-ai['"]/, /require\s*\(\s*['"]@google\/generative-ai['"]\s*\)/] },
  { sdk: '@aws-sdk/client-bedrock-runtime', patterns: [/from\s+['"]@aws-sdk\/client-bedrock-runtime['"]/, /require\s*\(\s*['"]@aws-sdk\/client-bedrock-runtime['"]\s*\)/] },
  { sdk: '@huggingface/inference', patterns: [/from\s+['"]@huggingface\/inference['"]/, /require\s*\(\s*['"]@huggingface\/inference['"]\s*\)/] },
  { sdk: 'replicate', patterns: [/from\s+['"]replicate['"]/, /require\s*\(\s*['"]replicate['"]\s*\)/] },
  { sdk: 'cohere-ai', patterns: [/from\s+['"]cohere-ai['"]/, /require\s*\(\s*['"]cohere-ai['"]\s*\)/] },
];

const PYTHON_PATTERNS: SDKPattern[] = [
  { sdk: 'anthropic', patterns: [/^(?:from\s+anthropic|import\s+anthropic)/] },
  { sdk: 'openai', patterns: [/^(?:from\s+openai|import\s+openai)/] },
  { sdk: 'google.generativeai', patterns: [/^(?:from\s+google\.generativeai|import\s+google\.generativeai)/] },
  { sdk: 'boto3-bedrock', patterns: [/bedrock-runtime/, /BedrockRuntime/] },
  { sdk: 'huggingface_hub', patterns: [/^(?:from\s+huggingface_hub|import\s+huggingface_hub)/] },
  { sdk: 'replicate', patterns: [/^(?:from\s+replicate|import\s+replicate)/] },
  { sdk: 'cohere', patterns: [/^(?:from\s+cohere|import\s+cohere)/] },
];

const JAVA_PATTERNS: SDKPattern[] = [
  { sdk: 'com.anthropic', patterns: [/import\s+com\.anthropic/] },
  { sdk: 'com.openai', patterns: [/import\s+com\.openai/] },
  { sdk: 'aws-bedrock', patterns: [/import\s+software\.amazon\.awssdk\.services\.bedrockruntime/] },
];

const GO_PATTERNS: SDKPattern[] = [
  { sdk: 'anthropic-sdk-go', patterns: [/github\.com\/anthropics\/anthropic-sdk-go/] },
  { sdk: 'openai-go', patterns: [/github\.com\/openai\/openai-go/] },
];

function getLanguage(file: string): string | null {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return 'javascript';
  if (/\.py$/.test(file)) return 'python';
  if (/\.java$/.test(file)) return 'java';
  if (/\.go$/.test(file)) return 'go';
  return null;
}

function getPatternsForLanguage(lang: string): SDKPattern[] {
  switch (lang) {
    case 'javascript': return JS_TS_PATTERNS;
    case 'python': return PYTHON_PATTERNS;
    case 'java': return JAVA_PATTERNS;
    case 'go': return GO_PATTERNS;
    default: return [];
  }
}

/**
 * Scan a string content for AI SDK imports.
 * Used by both file-based and content-based detection.
 */
export function detectImportsInContent(content: string, filePath: string): DetectedImport[] {
  const language = getLanguage(filePath);
  if (!language) return [];

  const patterns = getPatternsForLanguage(language);
  if (patterns.length === 0) return [];

  const results: DetectedImport[] = [];
  const lines = content.split('\n');

  // Track block comment state to skip commented-out imports
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle block comments (/* ... */) — may span multiple lines
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) continue; // Entire line is inside block comment
      line = line.slice(endIdx + 2);
      inBlockComment = false;
    }

    // Remove block comments that start and end on this line
    line = line.replace(/\/\*.*?\*\//g, '');

    // Check if a block comment starts on this line (and doesn't end)
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      line = line.slice(0, blockStart);
      inBlockComment = true;
    }

    // Strip single-line comments (// ...) and Python/Ruby comments (# ...)
    if (language === 'javascript' || language === 'java' || language === 'go') {
      line = line.replace(/\/\/.*$/, '');
    }
    if (language === 'python') {
      line = line.replace(/#.*$/, '');
    }

    if (!line.trim()) continue;

    for (const { sdk, patterns: regexes } of patterns) {
      for (const regex of regexes) {
        if (regex.test(line)) {
          results.push({
            file: filePath,
            line: i + 1,
            sdk,
            language,
            importStatement: lines[i].trim(),
          });
          break; // Don't double-match same SDK on same line
        }
      }
    }
  }

  return results;
}

/**
 * Scan a file for AI SDK imports.
 */
/** Maximum file size to scan (1 MB). Files larger than this are skipped. */
const MAX_FILE_SIZE = 1024 * 1024;

export function detectImportsInFile(filePath: string): DetectedImport[] {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return [];
    const content = readFileSync(filePath, 'utf-8');
    return detectImportsInContent(content, filePath);
  } catch {
    return [];
  }
}
