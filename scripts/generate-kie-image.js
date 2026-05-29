#!/usr/bin/env node
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

const ROOT = path.resolve(__dirname, '..');
const MODEL = 'gpt-image-2-text-to-image';
const DEFAULT_BASE_URL = 'https://api.kie.ai';
const CREATE_TASK_PATH = '/api/v1/jobs/createTask';
const TASK_DETAIL_PATH = '/api/v1/jobs/recordInfo';
const DEFAULT_OUTPUT_DIR = 'miniprogram/assets/images/generated';
const MANIFEST_PATH = 'miniprogram/utils/generated-images.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = current.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  KIE_API_KEY=*** npm run image:generate -- --name hero-cover --aspect-ratio 16:9 --prompt "your prompt"

Options:
  --prompt <text>              Text prompt for the image. If omitted in a TTY, the script asks interactively.
  --prompt-file <path>         Read prompt from a UTF-8 text file.
  --name <asset-name>          Output asset basename. Defaults to a prompt hash.
  --title <display-title>      Title written to the mini program image manifest.
  --aspect-ratio <ratio>       Kie aspect_ratio value. Defaults to 16:9.
  --output-dir <path>          Defaults to ${DEFAULT_OUTPUT_DIR}.
  --timeout-ms <number>        Defaults to 900000.
  --poll-interval-ms <number>  Defaults to 3000.
  --dry-run                   Print request payload and output paths without calling Kie.
  --help                      Show this help.

Security:
  Read the Kie key from KIE_API_KEY only. Do not commit the key or place it in mini program code.
`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function safeJoin(root, maybeRelative) {
  const resolved = path.resolve(root, maybeRelative);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes project root: ${maybeRelative}`);
  }
  return resolved;
}

function sanitizeName(input) {
  const ascii = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return ascii || 'kie-image';
}

function promptHash(prompt) {
  return crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 10);
}

async function readPrompt(args) {
  if (args.promptFile) {
    const promptPath = path.resolve(ROOT, args.promptFile);
    return (await fsp.readFile(promptPath, 'utf8')).trim();
  }

  if (typeof args.prompt === 'string') {
    return args.prompt.trim();
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question('请输入图片提示词: ')).trim();
    } finally {
      rl.close();
    }
  }

  return '';
}

function buildCreatePayload({ prompt, aspectRatio }) {
  return {
    model: MODEL,
    input: {
      prompt,
      aspect_ratio: aspectRatio
    }
  };
}

async function kieJson({ baseUrl, apiKey, pathname, method = 'GET', body }) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Kie returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`Kie request failed (${response.status}): ${JSON.stringify(json)}`);
  }

  if (json && typeof json === 'object' && 'code' in json && json.msg && json.msg !== 'success') {
    throw new Error(`Kie API error (${json.code}): ${json.msg}`);
  }

  return json;
}

function getTaskId(createResponse) {
  return createResponse?.data?.taskId || createResponse?.taskId || createResponse?.data?.id || createResponse?.id;
}

function normalizeState(record) {
  return String(record?.state || record?.status || record?.taskStatus || '').toLowerCase();
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
}

function collectUrls(value, urls = []) {
  const parsed = parseMaybeJson(value);

  if (typeof parsed === 'string') {
    const matches = parsed.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
    urls.push(...matches);
    return urls;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) collectUrls(item, urls);
    return urls;
  }

  if (parsed && typeof parsed === 'object') {
    for (const item of Object.values(parsed)) collectUrls(item, urls);
  }

  return urls;
}

function extractImageUrls(record) {
  const candidates = [
    record?.resultJson,
    record?.result,
    record?.response,
    record?.output,
    record?.data,
    record
  ];

  const urls = candidates.flatMap((candidate) => collectUrls(candidate));
  return [...new Set(urls)].filter((url) => /\.(png|jpe?g|webp)(\?|#|$)/i.test(url) || /image/i.test(url));
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('webp')) return '.webp';
  return '';
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = path.extname(pathname);
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch (_) {
    // Ignore malformed URLs; caller will fall back.
  }
  return '';
}

async function waitForTask({ baseUrl, apiKey, taskId, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let interval = pollIntervalMs;

  while (Date.now() < deadline) {
    const encodedTaskId = encodeURIComponent(taskId);
    const response = await kieJson({
      baseUrl,
      apiKey,
      pathname: `${TASK_DETAIL_PATH}?taskId=${encodedTaskId}`
    });
    const record = response?.data || response;
    const state = normalizeState(record);
    process.stdout.write(`Kie task ${taskId}: ${state || 'unknown'}\n`);

    if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(state)) {
      const urls = extractImageUrls(record);
      if (urls.length === 0) {
        throw new Error(`Kie task succeeded but no image URL was found: ${JSON.stringify(record).slice(0, 1000)}`);
      }
      return { record, imageUrl: urls[0] };
    }

    if (['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(state)) {
      throw new Error(`Kie task failed: ${JSON.stringify(record).slice(0, 1000)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(Math.round(interval * 1.25), 10000);
  }

  throw new Error(`Timed out waiting for Kie task ${taskId}`);
}

async function downloadImage(url, targetWithoutExt) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status}): ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extensionFromContentType(response.headers.get('content-type')) || extensionFromUrl(url) || '.png';
  const targetPath = `${targetWithoutExt}${ext}`;
  await fsp.writeFile(targetPath, buffer);
  return targetPath;
}

function loadManifest(absManifestPath) {
  if (!fs.existsSync(absManifestPath)) {
    return [];
  }
  delete require.cache[require.resolve(absManifestPath)];
  const manifest = require(absManifestPath);
  if (!Array.isArray(manifest)) {
    throw new Error(`${MANIFEST_PATH} must export an array`);
  }
  return manifest;
}

async function writeManifest(absManifestPath, items) {
  const source = `// Auto-generated by scripts/generate-kie-image.js.\n// Do not put API keys in this file.\nmodule.exports = ${JSON.stringify(items, null, 2)};\n`;
  await fsp.writeFile(absManifestPath, source, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const prompt = await readPrompt(args);
  if (!prompt) {
    fail('Missing --prompt, --prompt-file, or interactive prompt input.');
    return;
  }

  const aspectRatio = String(args.aspectRatio || '16:9');
  const baseUrl = String(process.env.KIE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const outputDir = safeJoin(ROOT, args.outputDir || DEFAULT_OUTPUT_DIR);
  const absManifestPath = safeJoin(ROOT, MANIFEST_PATH);
  const assetName = sanitizeName(args.name || `${prompt.split(/\s+/).slice(0, 5).join('-')}-${promptHash(prompt)}`);
  const title = String(args.title || assetName.replace(/-/g, ' '));
  const timeoutMs = Number(args.timeoutMs || 900000);
  const pollIntervalMs = Number(args.pollIntervalMs || 3000);
  const payload = buildCreatePayload({ prompt, aspectRatio });
  const targetWithoutExt = path.join(outputDir, assetName);

  if (args.dryRun) {
    console.log(JSON.stringify({
      baseUrl,
      createTaskPath: CREATE_TASK_PATH,
      taskDetailPath: TASK_DETAIL_PATH,
      outputDir: path.relative(ROOT, outputDir),
      manifest: MANIFEST_PATH,
      targetWithoutExt: path.relative(ROOT, targetWithoutExt),
      payload
    }, null, 2));
    return;
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    fail('KIE_API_KEY is not set. Export it only in your local shell; do not commit it.');
    return;
  }

  await fsp.mkdir(outputDir, { recursive: true });
  const createResponse = await kieJson({
    baseUrl,
    apiKey,
    pathname: CREATE_TASK_PATH,
    method: 'POST',
    body: payload
  });
  const taskId = getTaskId(createResponse);
  if (!taskId) {
    throw new Error(`Could not find taskId in Kie response: ${JSON.stringify(createResponse).slice(0, 1000)}`);
  }

  console.log(`Kie task created: ${taskId}`);
  const { imageUrl } = await waitForTask({ baseUrl, apiKey, taskId, timeoutMs, pollIntervalMs });
  const imagePath = await downloadImage(imageUrl, targetWithoutExt);
  const relativeImagePath = path.relative(path.join(ROOT, 'miniprogram'), imagePath).split(path.sep).join('/');

  const manifest = loadManifest(absManifestPath);
  const nextItem = {
    name: assetName,
    title,
    src: `/${relativeImagePath}`,
    prompt,
    model: MODEL,
    aspectRatio,
    taskId,
    createdAt: new Date().toISOString()
  };
  const nextManifest = [nextItem, ...manifest.filter((item) => item.name !== assetName)];
  await writeManifest(absManifestPath, nextManifest);

  console.log(`Saved image: ${path.relative(ROOT, imagePath)}`);
  console.log(`Updated manifest: ${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
