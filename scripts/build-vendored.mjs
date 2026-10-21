import { spawnSync } from 'node:child_process';
import {cpSync,existsSync,realpathSync,readdirSync,readFileSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
// Same bun build scripts as the source workspaces, in dependency order.
const order = [
  'bridle/contract', 'bridle/ledger', 'bridle/model-access',
  'bridle/core', 'bridle/cognition', 'bridle/secrets', 'bridle/perception',
  'bridle/knowledge', 'bridle/packs', 'bridle/lens', 'bridle/react', 'bridle/electron',
  'readflex/sqlite-driver', 'readflex/zotero-paths', 'readflex/reader-embed',
  'readflex/sidecar', 'readflex/zotero-bridge',
];
// Bun installs file: dependencies as copies, including nested peer copies.
// Keep source builds on their package's compiler and dependency versions.
const installedCopies=new Map(),visited=new Set();
function index(directory){
  const real=realpathSync(directory);
  if(visited.has(real))return;
  visited.add(real);
  for(const entry of readdirSync(real,{withFileTypes:true})){
    if(entry.name.startsWith('.'))continue;
    const path=join(real,entry.name);
    if(entry.name.startsWith('@')){index(path);continue;}
    if(!existsSync(join(path,'package.json')))continue;
    const manifest=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
    if(order.some(name=>manifest.name===`@${name}`)){
      const key=`${manifest.name}@${manifest.version}`;
      installedCopies.set(key,[...(installedCopies.get(key)||[]),realpathSync(path)]);
    }
    if(existsSync(join(path,'node_modules')))index(join(path,'node_modules'));
  }
}
index(resolve('node_modules'));
for (const name of order) {
  const source=resolve(`packages/${name}`),installed=resolve(`node_modules/@${name}`);
  if(!existsSync(installed))throw new Error(`Missing installed local package: ${name}`);
  const dependencies=join(installed,'node_modules'),sourceDependencies=join(source,'node_modules');
  if(existsSync(dependencies)&&!existsSync(sourceDependencies))symlinkSync(dependencies,sourceDependencies,process.platform==='win32'?'junction':'dir');
  const result = spawnSync('bun', ['run', '--cwd', source, 'build'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  if (process.platform === 'win32' && name === 'bridle/core') {
    const helper = spawnSync('bun', ['run', '--cwd', source, 'build:helper'], { stdio: 'inherit' });
    if (helper.status !== 0) process.exit(helper.status || 1);
  }
  const manifest=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  for(const copy of installedCopies.get(`${manifest.name}@${manifest.version}`)||[])if(realpathSync(source)!==copy)for(const folder of ['dist','bin'])if(existsSync(join(source,folder)))cpSync(join(source,folder),join(copy,folder),{recursive:true,force:true});
}
