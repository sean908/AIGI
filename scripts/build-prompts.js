'use strict';

const fs = require('fs');
const path = require('path');

const EXCLUDED_FILENAMES = new Set([
  'index.json',
  'aggregated.json',
  'summary.json',
  'prompts.json'
]);

class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

function parseArgs(argv) {
  const defaults = {
    promptsDir: path.resolve(process.cwd(), 'prompts'),
    outputDir: null,
    generatedAt: null
  };

  const args = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--prompts-dir') {
      args.promptsDir = path.resolve(argv[++i] || '');
      continue;
    }
    if (arg === '--output-dir') {
      args.outputDir = path.resolve(argv[++i] || '');
      continue;
    }
    if (arg === '--generated-at') {
      args.generatedAt = argv[++i] || '';
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new BuildError(`Unknown argument: ${arg}`);
  }

  args.outputDir = args.outputDir || args.promptsDir;
  return args;
}

function printHelp() {
  console.log([
    'Build AIGI prompt artifacts: index.json, aggregated.json, summary.json',
    '',
    'Usage:',
    '  node scripts/build-prompts.js [--prompts-dir <dir>] [--output-dir <dir>] [--generated-at <iso8601>]',
    '',
    'Defaults:',
    '  --prompts-dir ./prompts',
    '  --output-dir <prompts-dir>'
  ].join('\n'));
}

function ensureDirectoryExists(dirAbs, label) {
  let stat;
  try {
    stat = fs.statSync(dirAbs);
  } catch (error) {
    throw new BuildError(`${label} does not exist: ${dirAbs}`);
  }
  if (!stat.isDirectory()) {
    throw new BuildError(`${label} is not a directory: ${dirAbs}`);
  }
}

function walkPromptJsonFiles(dirAbs) {
  const out = [];
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkPromptJsonFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    if (EXCLUDED_FILENAMES.has(entry.name)) continue;
    out.push(fullPath);
  }
  return out;
}

function toPosixRelativePath(rootAbs, fileAbs) {
  return path.relative(rootAbs, fileAbs).split(path.sep).join('/');
}

function derivePromptKeyFromRelativePath(relativeFilePath) {
  return relativeFilePath.replace(/\.json$/i, '');
}

function readJsonFile(fileAbs, relativePath) {
  let raw;
  try {
    raw = fs.readFileSync(fileAbs, 'utf8');
  } catch (error) {
    throw new BuildError(`failed to read ${relativePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new BuildError(`invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function requireObject(value, relativePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuildError(`${relativePath}: expected a JSON object at top-level`);
  }
  return value;
}

function requireNonEmptyString(value, fieldName, relativePath) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BuildError(`${relativePath}: missing/invalid required field "${fieldName}"`);
  }
  return value;
}

function requireStringList(value, fieldName, relativePath, allowMissing = true) {
  if (value === undefined || value === null) {
    if (allowMissing) return [];
    throw new BuildError(`${relativePath}: missing required field "${fieldName}"`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BuildError(`${relativePath}: field "${fieldName}" must be a list of strings`);
  }
  return value;
}

function normalizeImagesObject(value, relativePath) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuildError(`${relativePath}: field "images" must be an object`);
  }
  return value;
}

function normalizeNote(value, relativePath) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new BuildError(`${relativePath}: field "note" must be a string`);
  }
  return value;
}

function getPinnedPosition(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compareByPinnedThenKey(a, b) {
  const aPin = a.pinnedPosition;
  const bPin = b.pinnedPosition;
  const aHasPin = aPin !== null;
  const bHasPin = bPin !== null;

  if (aHasPin && !bHasPin) return -1;
  if (!aHasPin && bHasPin) return 1;
  if (aHasPin && bHasPin && aPin !== bPin) return aPin - bPin;
  return a.id.localeCompare(b.id);
}

function collectPromptFiles(promptsDirAbs) {
  return walkPromptJsonFiles(promptsDirAbs)
    .map((fileAbs) => {
      const relativePath = toPosixRelativePath(promptsDirAbs, fileAbs);
      return {
        fileAbs,
        relativePath,
        id: derivePromptKeyFromRelativePath(relativePath)
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function collectPromptRecords(promptsDirAbs) {
  const promptFiles = collectPromptFiles(promptsDirAbs);
  const seenIds = new Set();

  return promptFiles.map(({ fileAbs, relativePath, id }) => {
    if (seenIds.has(id)) {
      throw new BuildError(`duplicate prompt id "${id}"`);
    }
    seenIds.add(id);

    const raw = requireObject(readJsonFile(fileAbs, relativePath), relativePath);
    return {
      fileAbs,
      relativePath,
      id,
      raw,
      pinnedPosition: getPinnedPosition(raw.pinned_position)
    };
  });
}

function buildIndexDocument(promptRecords) {
  const items = promptRecords
    .map(({ id, relativePath, pinnedPosition }) => ({
      id,
      file: relativePath,
      pinnedPosition
    }))
    .sort(compareByPinnedThenKey)
    .map(({ id, file }) => ({ id, file }));

  return { prompts: items };
}

function buildAggregatedDocument(promptRecords, generatedAt) {
  const prompts = promptRecords.map(({ raw, relativePath, id, pinnedPosition }) => {
    const title = requireNonEmptyString(raw.title, 'title', relativePath);
    const prompt = requireNonEmptyString(raw.prompt, 'prompt', relativePath);
    const tags = requireStringList(raw.tags, 'tags', relativePath, true);
    const images = normalizeImagesObject(raw.images, relativePath);
    const note = normalizeNote(raw.note, relativePath);

    const normalized = {
      id,
      title,
      tags,
      prompt,
      images,
      note
    };

    if (pinnedPosition !== null) normalized.pinned_position = pinnedPosition;
    return { ...normalized, _sortPinnedPosition: pinnedPosition };
  });

  prompts.sort((a, b) => compareByPinnedThenKey(
    { id: a.id, pinnedPosition: a._sortPinnedPosition },
    { id: b.id, pinnedPosition: b._sortPinnedPosition }
  ));

  return {
    schemaVersion: 2,
    generatedAt: generatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prompts: prompts.map(({ _sortPinnedPosition, ...rest }) => rest)
  };
}

function extractGeneratedImages(raw, relativePath) {
  if (Object.prototype.hasOwnProperty.call(raw, 'generatedImages')) {
    return requireStringList(raw.generatedImages, 'generatedImages', relativePath, true);
  }

  const images = normalizeImagesObject(raw.images, relativePath);
  return requireStringList(images.generated, 'images.generated', relativePath, true);
}

function buildSummaryDocument(promptRecords) {
  const items = promptRecords.map(({ raw, relativePath, id, pinnedPosition }) => {
    const title = requireNonEmptyString(raw.title, 'title', relativePath);
    const tags = requireStringList(raw.tags, 'tags', relativePath, false);
    const generatedImages = extractGeneratedImages(raw, relativePath);

    const normalized = {
      id,
      title,
      tags,
      generatedImages
    };

    if (pinnedPosition !== null) normalized.pinned_position = pinnedPosition;
    return { ...normalized, _sortPinnedPosition: pinnedPosition };
  });

  items.sort((a, b) => compareByPinnedThenKey(
    { id: a.id, pinnedPosition: a._sortPinnedPosition },
    { id: b.id, pinnedPosition: b._sortPinnedPosition }
  ));

  return items.map(({ _sortPinnedPosition, ...rest }) => rest);
}

function writeJsonFile(fileAbs, payload) {
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
  fs.writeFileSync(fileAbs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildAllArtifacts({ promptsDir, outputDir, generatedAt }) {
  ensureDirectoryExists(promptsDir, 'prompts dir');
  fs.mkdirSync(outputDir, { recursive: true });

  const promptRecords = collectPromptRecords(promptsDir);

  const indexDocument = buildIndexDocument(promptRecords);
  const aggregatedDocument = buildAggregatedDocument(promptRecords, generatedAt);
  const summaryDocument = buildSummaryDocument(promptRecords);

  const indexPath = path.join(outputDir, 'index.json');
  const aggregatedPath = path.join(outputDir, 'aggregated.json');
  const summaryPath = path.join(outputDir, 'summary.json');

  writeJsonFile(indexPath, indexDocument);
  writeJsonFile(aggregatedPath, aggregatedDocument);
  writeJsonFile(summaryPath, summaryDocument);

  return {
    promptCount: promptRecords.length,
    indexPath,
    aggregatedPath,
    summaryPath
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = buildAllArtifacts(args);
    console.log(`wrote ${result.indexPath} (${result.promptCount} prompts)`);
    console.log(`wrote ${result.aggregatedPath} (${result.promptCount} prompts)`);
    console.log(`wrote ${result.summaryPath} (${result.promptCount} prompts)`);
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  }
}

main();
