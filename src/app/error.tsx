'use client';

import { RouteError } from '@/components/shared/route-error';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <RouteError error={error} reset={reset} homeHref="/workspace" />
    </div>
  );
}
