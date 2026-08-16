import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {it} from 'vitest';
import App from '../../../src/App';
import {captureDocument} from '../capture';

it('captures the document lifecycle shell',async()=>{
 const user=userEvent.setup(); render(<App/>);
 await screen.findByRole('heading',{name:'Your data, in one portable file.'});
 await captureDocument(document,{name:'app-qa-01-start',expectations:['New and Open document actions are prominent.','Recent documents has a clear empty state.']});
 await user.click(screen.getByRole('button',{name:/New document/}));
 await screen.findByRole('heading',{name:'Tables'});
 await captureDocument(document,{name:'app-qa-02-data',expectations:['The document shell shows Data mode and Tables navigation.','Save and Save As actions and embedded attachments are visible.']});
 await user.click(screen.getByRole('button',{name:'Design'}));
 await screen.findByRole('heading',{name:'Forms'});
 await captureDocument(document,{name:'app-qa-03-design',expectations:['Design mode is selected.','Forms and Switchboards navigation is visible.']});
});
