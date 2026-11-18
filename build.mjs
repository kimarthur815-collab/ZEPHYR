import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

const r = await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/index.html', 'utf8').replace('/*BUNDLE*/', () => js);
// built game goes to the repo root so GitHub Pages serves it at the main link
writeFileSync('index.html', html);
console.log('built', (html.length / 1024).toFixed(0) + ' KB');
