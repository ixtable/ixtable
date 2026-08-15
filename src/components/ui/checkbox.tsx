import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import {Check} from 'lucide-react';
import {cn} from '../../lib/utils';
export const Checkbox=React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>,React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(({className,...props},ref)=><CheckboxPrimitive.Root ref={ref} className={cn('peer size-4 shrink-0 rounded border border-zinc-300 bg-white data-[state=checked]:border-zinc-800 data-[state=checked]:bg-zinc-800 data-[state=checked]:text-white',className)} {...props}><CheckboxPrimitive.Indicator className="flex items-center justify-center"><Check className="size-3"/></CheckboxPrimitive.Indicator></CheckboxPrimitive.Root>);
Checkbox.displayName='Checkbox';

