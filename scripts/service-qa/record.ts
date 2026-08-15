import fs from 'node:fs';
import path from 'node:path';
export function recordOutcome(name:string,input:{expectations:string[];details:Record<string,unknown>}){
  if(!input.expectations.length||input.expectations.length>3) throw new Error('An outcome needs 1–3 expectations.');
  const dir=path.resolve(import.meta.dirname,'.generated');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,`${name}.json`),JSON.stringify({name,recordedAt:new Date().toISOString(),...input},null,2));
}

