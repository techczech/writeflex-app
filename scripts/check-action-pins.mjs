#!/usr/bin/env node
import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import pathAPI,{resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
// Accept the block-mapping YAML subset used by our workflows. Ambiguous YAML
// (flow mappings, anchors, aliases, explicit keys, escaped keys) fails closed.
// Block scalar bodies are commands/documentation, not YAML action references.
function references(source,name){
 const refs=[];let blockIndent=null;
 for(const [index,line]of source.split('\n').entries()){
  const indent=line.match(/^ */)[0].length;
  if(blockIndent!==null){if(!line.trim()||indent>blockIndent)continue;blockIndent=null;}
  let quote=null,comment=line.length;
  for(let i=0;i<line.length;i++){const c=line[i];if(quote){if(c===quote){if(quote==="'"&&line[i+1]==="'"){i++;continue;}quote=null;}else if(c==='\\'&&quote==='"')i++;}else if(c==='"'||c==="'")quote=c;else if(c==='#'&&(i===0||/\s/.test(line[i-1]))){comment=i;break;}}
  const code=line.slice(0,comment).trim();
  const syntax=code.replace(/\$\{\{.*?\}\}/g,'EXPRESSION');
  if(!code)continue;
  if(/^(?:-\s+)?run:\s*(?![|>])\S/.test(code))continue;
  if(quote||/\t|[{}]|(?:^|\s)[&*?]|\\/.test(syntax))throw new Error(`${name}:${index+1}: unsupported YAML form`);
  const mapping=code.match(/^(?:-\s+)?(?:[\w-]+|"[\w-]+"|'[\w-]+')\s*:\s*(.*)$/);
  if(!mapping)throw new Error(`${name}:${index+1}: unsupported YAML form`);
  const using=code.match(/^(?:-\s+)?(?:using|"using"|'using')\s*:\s*(.*)$/);
  if(using&&!/^(?:composite|node\d+|"(?:composite|node\d+)"|'(?:composite|node\d+)')$/.test(using[1]))throw new Error(`${name}:${index+1}: Docker or unsupported action using`);
  const key=code.match(/^(?:-\s+)?(?:uses|"uses"|'uses')\s*:\s*(.*)$/);
  if(key){
   let value=key[1];if(/^['"]/.test(value)){const q=value[0];if(value.at(-1)!==q)throw new Error(`${name}:${index+1}: unparseable uses`);value=value.slice(1,-1);}
   if(!/^(?:\.\/[\w./-]+|[\w.-]+\/[\w./-]+@[a-f0-9]{40})$/.test(value))throw new Error(`${name}:${index+1}: action must have SHA or local path`);
   refs.push({value,version:line.slice(comment+1).trim(),line:index+1});
  }else if(/uses/.test(code))throw new Error(`${name}:${index+1}: unparseable uses/YAML form`);
  if(/^[|>]/.test(mapping[1])){
   if(!/^[|>][+-]?$/.test(mapping[1]))throw new Error(`${name}:${index+1}: unsupported block scalar`);
   // A sequence dash is outside the mapping: the sibling key starts after it.
   blockIndent=indent+(code.match(/^-\s+/)?.[0].length||0);
  }
 }
 return refs;
}
export function workflowRoot(directory,paths=pathAPI){
 directory=paths.resolve(directory);
 return paths.basename(directory)==='workflows'&&paths.basename(paths.dirname(directory))==='.github'?paths.resolve(directory,'../..'):directory;
}
export function checkActionPins(directory,remote=(repo,ref)=>execFileSync('git',['ls-remote',`https://github.com/${repo}.git`,ref,`${ref}^{}`],{encoding:'utf8',timeout:30000})){
 directory=resolve(directory);
 const pins=new Map(),visited=new Set();
 const root=workflowRoot(directory);
 function scan(path){
  if(lstatSync(path).isSymbolicLink())throw new Error('Action definition symlink');
  if(visited.has(path))return;visited.add(path);
  for(const {value,version,line}of references(readFileSync(path,'utf8'),path)){
   if(value.startsWith('./')){
    const target=resolve(root,value),rel=relative(root,target);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+pathAPI.sep)||value.split('/').includes('..'))throw new Error('Unsafe local action');
    let p=target;while(p!==root){if(lstatSync(p).isSymbolicLink())throw new Error('Local action symlink');p=dirname(p);}
    const definition=['action.yml','action.yaml'].map(p=>join(target,p)).find(existsSync);
    if(!definition)throw new Error('Missing local action YAML');scan(definition);continue;
   }
   const m=value.match(/^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([a-f0-9]{40})$/);
   if(!m||! /^(v\d[\w.-]*|refs\/heads\/[\w./-]+)$/.test(version))throw new Error(`${path}:${line}: action must have SHA and exact version/ref comment`);
   const [,repo,sha]=m,ref=version.startsWith('refs/')?version:`refs/tags/${version}`;
   pins.set(`${repo} ${ref} ${sha}`,{repo,ref,sha});
  }
 }
 function walk(path){if(lstatSync(path).isSymbolicLink())throw new Error('Action directory symlink');for(const name of readdirSync(path)){const p=join(path,name),s=lstatSync(p);if(s.isSymbolicLink())throw new Error('Action directory symlink');if(s.isDirectory())walk(p);else if(/\.ya?ml$/.test(name))scan(p);}}
 walk(directory);
 const actions=join(root,'.github/actions');if(existsSync(actions))walk(actions);
 for(const {repo,ref,sha}of pins.values()){
  const rows=remote(repo,ref).trim().split('\n').map(s=>s.split(/\s+/));
  const actual=(rows.find(r=>r[1]===`${ref}^{}`)||rows.find(r=>r[1]===ref))?.[0];
  if(actual!==sha)throw new Error(`${repo}: pinned SHA does not match ${ref}`);
 }
 return pins.size;
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
 const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../.github/workflows');
 console.log(`Action pins PASS (${checkActionPins(process.argv[2]||directory)} unique pins).`);
}
