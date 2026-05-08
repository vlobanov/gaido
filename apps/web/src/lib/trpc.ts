import { createTRPCReact } from '@trpc/react-query';
import {
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from '@trpc/client';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClient as RQClient } from '@tanstack/react-query';
import { trpcHttpUrl, wsUrl } from './url';
import type { AppRouter } from '@gaido/server';

export const trpc = createTRPCReact<AppRouter>();

export function createQueryClient(): QueryClient {
  return new RQClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

export function createTrpcClient() {
  const wsClient = createWSClient({ url: wsUrl });

  return trpc.createClient({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({ url: trpcHttpUrl }),
      }),
    ],
  });
}
