import fs from 'fs';
import path from 'path';

const manifestPath = path.join(process.cwd(), 'dist', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Inject content_scripts back into the generated manifest
manifest.content_scripts = [
  {
    "matches": [
      "*://*.x.com/*",
      "*://*.twitter.com/*",
      "*://*.youtube.com/*"
    ],
    "js": [
      "content_script.js"
    ],
    "run_at": "document_end"
  }
];

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log('[patch_manifest] Successfully injected content_scripts into dist/manifest.json');
