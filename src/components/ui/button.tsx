'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-t4d text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900',
        secondary: 'bg-brand-100 text-brand-900 hover:bg-brand-200',
        outline: 'border border-line bg-surface text-ink hover:bg-brand-50 hover:border-brand-300',
        ghost: 'text-ink hover:bg-brand-50',
        danger: 'bg-danger text-white hover:brightness-95',
        link: 'text-brand-700 underline-offset-2 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 text-[12px] [&_svg]:size-3',
        sm: 'h-7 px-2.5 [&_svg]:size-3.5',
        md: 'h-8 px-3 [&_svg]:size-4',
        lg: 'h-9 px-4 [&_svg]:size-4',
        icon: 'h-7 w-7 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'sm' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      type={asChild ? undefined : (type ?? 'button')}
      {...props}
    />
  );
});

export { buttonVariants };
