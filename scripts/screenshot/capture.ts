import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const generated=path.resolve(import.meta.dirname,'.generated');
export type CaptureOptions={name:string;expectations:string[];viewport?:{width:number;height:number}};

export async function captureDocument(doc:Document,{name,expectations,viewport={width:1280,height:800}}:CaptureOptions){
  if(!expectations.length||expectations.length>3) throw new Error('A capture needs 1–3 visual expectations.');
  const cssPath=path.join(generated,'app.css');
  if(!fs.existsSync(cssPath)) throw new Error('Missing screenshot CSS. Run npm run screenshot:css.');
  fs.mkdirSync(generated,{recursive:true});
  const htmlPath=path.join(generated,`${name}.html`);
  const pngPath=path.join(generated,`${name}.png`);
  const snapshot=doc.body.cloneNode(true) as HTMLBodyElement;
  const liveControls=doc.body.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select');
  const clonedControls=snapshot.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select');
  liveControls.forEach((live,index)=>{
    const clone=clonedControls[index];
    if(live instanceof HTMLInputElement&&clone instanceof HTMLInputElement){clone.setAttribute('value',live.value);if(live.checked)clone.setAttribute('checked','');else clone.removeAttribute('checked');}
    if(live instanceof HTMLTextAreaElement&&clone instanceof HTMLTextAreaElement)clone.textContent=live.value;
    if(live instanceof HTMLSelectElement&&clone instanceof HTMLSelectElement)Array.from(clone.options).forEach((option,i)=>option.toggleAttribute('selected',i===live.selectedIndex));
  });
  const html=`<!doctype html><html class="${doc.documentElement.className}"><head><meta charset="utf-8"><style>${fs.readFileSync(cssPath,'utf8')}</style></head><body class="${doc.body.className}">${snapshot.innerHTML}</body></html>`;
  fs.writeFileSync(htmlPath,html);
  const browser=await chromium.launch({headless:true});
  try{const page=await browser.newPage({viewport});await page.goto(`file://${htmlPath}`);await page.screenshot({path:pngPath,fullPage:true});}finally{await browser.close();}
  fs.writeFileSync(path.join(generated,`${name}.json`),JSON.stringify({name,capturedAt:new Date().toISOString(),expectations},null,2));
  return pngPath;
}
