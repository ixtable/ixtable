import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {it} from 'vitest';
import App from '../../../src/App';
import {captureDocument} from '../capture';

it('captures the main project workflow',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await screen.findByRole('heading',{name:'Projects'});
  await captureDocument(document,{name:'app-qa-01-projects',expectations:['The ixtable sidebar and Projects heading are visible.','Five project rows appear in a clean desktop table.','The dark New project action is visible at the top right.']});
  await user.type(screen.getByRole('textbox',{name:'Search projects'}),'design system');
  await screen.findByDisplayValue('Design system');
  await captureDocument(document,{name:'app-qa-02-filtered',expectations:['The search field contains “design system”.','Only the Design system project row remains visible.']});
});

