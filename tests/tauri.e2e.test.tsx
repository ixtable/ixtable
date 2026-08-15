import {render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import App from '../src/App';

it('renders the desktop UI and invokes the real Rust backend',async()=>{
  render(<App/>);
  expect(screen.getByRole('heading',{name:'Projects'})).toBeInTheDocument();
  await expect(invoke('app_info', {})).resolves.toEqual({name:'ixtable',runtime:'tauri'});
});
