#!/usr/bin/env node

/**
 * Copy non-TypeScript assets to dist folders
 * This script runs after the TypeScript build to copy files like .sql that aren't compiled
 */

const fs = require('fs');
const path = require('path');

const assets = [
  {
    source: 'packages/server/src/database/schema.sql',
    target: 'packages/server/dist/database/schema.sql',
  },
];

function copyFile(source, target) {
  const sourcePath = path.resolve(__dirname, '..', source);
  const targetPath = path.resolve(__dirname, '..', target);

  // Ensure target directory exists
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy the file
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`Copied: ${source} -> ${target}`);
}

function main() {
  let copied = 0;
  let errors = 0;

  for (const asset of assets) {
    try {
      copyFile(asset.source, asset.target);
      copied++;
    } catch (error) {
      console.error(`Failed to copy ${asset.source}:`, error.message);
      errors++;
    }
  }

  console.log(`\nCopied ${copied} asset(s)${errors > 0 ? `, ${errors} error(s)` : ''}`);

  if (errors > 0) {
    process.exit(1);
  }
}

main();
