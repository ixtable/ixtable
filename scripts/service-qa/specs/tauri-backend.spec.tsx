import {render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {it,expect} from 'vitest';
import {captureDocument} from '../../screenshot/capture';
import {recordOutcome} from '../record';

it('checks the real Tauri command bridge and captures its result',async()=>{
  const info=await invoke<{name:string;runtime:string}>('app_info',{});
  expect(info).toEqual({name:'ixtable',runtime:'tauri'});
  recordOutcome('service-qa-01-tauri-command',{expectations:['The real Rust app_info command returns the ixtable application identity.'],details:info});
  render(<main className="min-h-screen bg-zinc-50 p-16"><section className="mx-auto max-w-xl rounded-xl border border-zinc-200 bg-white p-8 shadow-sm"><p className="text-xs font-bold uppercase tracking-widest text-zinc-400">Service QA</p><h1 className="mt-3 text-3xl font-bold text-zinc-900">Backend connected</h1><p className="mt-2 text-zinc-500">The jsdom UI invoked the real Rust command through tauri-test.</p><dl className="mt-8 grid grid-cols-2 gap-4 rounded-lg bg-zinc-100 p-5"><div><dt className="text-xs text-zinc-500">Application</dt><dd className="font-semibold">{info.name}</dd></div><div><dt className="text-xs text-zinc-500">Runtime</dt><dd className="font-semibold">{info.runtime}</dd></div></dl></section></main>);
  await screen.findByRole('heading',{name:'Backend connected'});
  await captureDocument(document,{name:'service-qa-01-tauri-command',expectations:['A Backend connected result is clearly visible.','Application is ixtable and runtime is tauri.']});
});

