import * as React from 'react';
import {cn} from '../../lib/utils';
export const Input=React.forwardRef<HTMLInputElement,React.InputHTMLAttributes<HTMLInputElement>>(({className,...props},ref)=><input ref={ref} className={cn('flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 py-1 text-sm outline-none focus:ring-2 focus:ring-zinc-300',className)} {...props}/>);
Input.displayName='Input';

