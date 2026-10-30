import { spawnSync } from 'node:child_process';
import {cpSync,existsSync,realpathSync,readdirSync,readFileSync,symlinkSync,lstatSync,readlinkSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
// Remove only the exact link this helper creates; never follow it when deleting.
export function linkSourceDependencies(source, installed) {
  const target=join(installed,'node_modules'),link=join(source,'node_modules');
  let stat;
  try { stat=lstatSync(link); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(stat?.isSymbolicLink() && resolve(dirname(link),readlinkSync(link))===target && !existsSync(target)) {
    unlinkSync(link);
    stat=undefined;
  }
  if(!stat && existsSync(target))symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
}
export function withSourceDependencies(source, installed, build) {
  const link=join(source,'node_modules'),target=join(installed,'node_modules');
  try {
    linkSourceDependencies(source,installed);
    return build();
  } finally {
    let stat;
    try { stat=lstatSync(link); } catch(error) { if(error.code!=='ENOENT')throw error; }
    if(stat?.isSymbolicLink() && resolve(dirname(link),readlinkSync(link))===target)unlinkSync(link);
  }
}
export function validateBuildCompiler(root) {
  const compiler=join(root,'node_modules/writeflex-build-typescript');
  const manifest=JSON.parse(readFileSync(join(compiler,'package.json'),'utf8'));
  if(manifest.name!=='typescript'||manifest.version!=='6.0.3'||!existsSync(join(compiler,'bin/tsc'))) {
    throw new Error('Public SDK build requires writeflex-build-typescript npm:typescript@6.0.3');
  }
}
export function buildVendored() {
validateBuildCompiler(resolve('.'));
// Same bun build scripts as the source workspaces, in dependency order.
const order = [
  'bridle/contract', 'bridle/ledger', 'bridle/model-access',
  'bridle/core', 'bridle/cognition', 'bridle/secrets', 'bridle/perception',
  'bridle/knowledge', 'bridle/packs', 'bridle/lens', 'bridle/react', 'bridle/electron',
  'readflex/sqlite-driver', 'readflex/zotero-paths', 'readflex/reader-embed',
  'readflex/sidecar', 'readflex/zotero-bridge',
];
// Bun installs file: dependencies as copies, including nested peer copies.
// SDK declarations use the pinned public compiler; nested runtime dependencies stay package-local when present.
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
  const status=withSourceDependencies(source,installed,()=>{
  const result = spawnSync('bun', ['run', '--cwd', source, 'build'], { stdio: 'inherit' });
  if (result.status !== 0) return result.status || 1;
  if (process.platform === 'win32' && name === 'bridle/core') {
    const helper = spawnSync('bun', ['run', '--cwd', source, 'build:helper'], { stdio: 'inherit' });
    if (helper.status !== 0) return helper.status || 1;
  }
  const manifest=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  for(const copy of installedCopies.get(`${manifest.name}@${manifest.version}`)||[])if(realpathSync(source)!==copy)for(const folder of ['dist','bin'])if(existsSync(join(source,folder))){
    // @bridle/contract's root copy is installed from the reviewed release archive and already
    // carries its tested dist; never overwrite that payload with the local source build.
    // Copies without the folder (nested peer copies of the source package) still receive it.
    if(manifest.name==='@bridle/contract'&&existsSync(join(copy,folder)))continue;
    cpSync(join(source,folder),join(copy,folder),{recursive:true,force:true});
  }
  return 0;
  });
  if(status!==0)return status;
}

}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=buildVendored()||0;
