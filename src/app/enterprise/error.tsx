'use client';

import { RouteError } from '@/components/shared/route-error';

export default function EnterpriseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6">
      <RouteError error={error} reset={reset} homeHref="/enterprise/dashboard" />
    </div>
  );
}
