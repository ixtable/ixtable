import '@testing-library/jest-dom/vitest';
import {createRequire} from 'node:module';
import {vi} from 'vitest';
const require=createRequire(import.meta.url);
export const tauriTest=require('../src-tauri/target/index.cjs') as {invoke:(cmd:string,args?:Record<string,unknown>)=>Promise<unknown>};
vi.mock('@tauri-apps/api/core',()=>({invoke:tauriTest.invoke}));
