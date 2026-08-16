import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {invoke} from '@tauri-apps/api/core';
import App from '../src/App';

it('renders the desktop UI and invokes the real Rust backend',async()=>{
  render(<App/>);
  expect(screen.getByRole('heading',{name:'Your data, in one portable file.'})).toBeInTheDocument();
  await expect(invoke('app_info', {})).resolves.toEqual({name:'ixtable',runtime:'tauri'});
  await userEvent.click(screen.getByRole('button',{name:/New document/}));
  expect(await screen.findByRole('heading',{name:'Tables'})).toBeInTheDocument();
});
