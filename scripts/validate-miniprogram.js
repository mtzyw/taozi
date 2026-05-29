const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const requiredFiles = [
  'project.config.json',
  'miniprogram/app.json',
  'miniprogram/app.js',
  'miniprogram/app.wxss',
  'miniprogram/sitemap.json',
  'miniprogram/utils/generated-images.js'
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`Missing required file: ${file}`);
  }
}

for (const file of requiredFiles.filter((file) => file.endsWith('.json'))) {
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of appConfig.pages || []) {
  for (const ext of ['json', 'js', 'wxml', 'wxss']) {
    const file = path.join(root, 'miniprogram', `${page}.${ext}`);
    if (!fs.existsSync(file)) {
      throw new Error(`Page declared in app.json but missing ${ext.toUpperCase()}: ${page}`);
    }
    if (ext === 'json') {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
}

const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'miniprogram_npm') walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      jsFiles.push(fullPath);
    }
  }
}
walk(path.join(root, 'miniprogram'));
walk(path.join(root, 'scripts'));

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`JavaScript syntax check failed for ${path.relative(root, file)}:\n${result.stderr || result.stdout}`);
  }
}

const generatedImages = require(path.join(root, 'miniprogram/utils/generated-images.js'));
if (!Array.isArray(generatedImages)) {
  throw new Error('generated-images.js must export an array');
}

for (const item of generatedImages) {
  if (!item || typeof item !== 'object') {
    throw new Error('Each generated image entry must be an object');
  }
  if (!item.name || !item.src) {
    throw new Error('Each generated image entry must include name and src');
  }
  const isRemoteImage = /^https:\/\//i.test(item.src);
  const isMiniAssetImage = item.src.startsWith('/assets/images/generated/');
  const isServerUploadImage = item.src.startsWith('/uploads/seed-images/');
  if (!isRemoteImage && !isMiniAssetImage && !isServerUploadImage) {
    throw new Error(`Generated image src must be HTTPS, /uploads/seed-images/ or stay under /assets/images/generated/: ${item.src}`);
  }
  if (isMiniAssetImage) {
    const imagePath = path.join(root, 'miniprogram', item.src.replace(/^\/+/, ''));
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Generated image manifest points to a missing file: ${item.src}`);
    }
  }
  if (isServerUploadImage) {
    const imagePath = path.join(root, 'admin-web', item.src.replace(/^\/uploads\//, 'uploads/'));
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Generated image manifest points to a missing server upload: ${item.src}`);
    }
  }
}

console.log('微信小程序基础配置校验通过');
