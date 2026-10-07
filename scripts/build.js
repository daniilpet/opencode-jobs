import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { transformFileAsync } from '@babel/core';
import solid from 'babel-preset-solid';

await mkdir('dist', { recursive: true });
const result = await transformFileAsync('src/tui.jsx', { presets: [[solid, { generate: 'universal', moduleName: '@opentui/solid' }]] });
await writeFile('dist/tui.js', result.code.replace(/(['"])\.\/(contract|job-activity|sanitize)\.js\1/g, '$1../src/$2.js$1') + '\n');
await cp('node_modules/@opencode/client/dist', 'vendor/client', { recursive: true });
await mkdir('.runtime/package', { recursive: true });
for (const name of ['src', 'dist', 'vendor']) await cp(name, `.runtime/package/${name}`, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
await writeFile('.runtime/package/package.json', JSON.stringify(manifest, null, 2) + '\n');
await writeFile('.runtime/package/index.js', "export { default } from './src/index.js';\n");
await writeFile('.runtime/package/tui.js', "export { default } from './dist/tui.js';\n");
for (const name of ['README.md', 'DEPLOYMENT.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.txt', 'docs']) await cp(name, `.runtime/package/${name}`, { recursive: true });
process.stdout.write('Артефакт: .runtime/package; сервер и pump автономны, TUI использует shared runtime OpenCode.\n');
